import { createHash, randomUUID } from 'node:crypto';
import type { PreparationProgress, SourceDocument, SourceRights } from '@pen/contracts';
import { normalizeTopic } from '@pen/onten';
import type { CompileProgress, Pack, ProgressiveCompilation, ProvisionalReceipt, QualifiedPackReference, TopicResolution } from '@pen/onten';
import { abortError, Fetcher, type FetchedPage, FetchQueue, HostThrottle, hostOf, isAbortError } from './fetcher.js';
import { htmlToMarkdown } from './html-to-markdown.js';
import { heuristicEvaluation, heuristicOutline, requestEvaluation, requestOutline } from './outline.js';
import { ProgressReporter, READY_FRACTION } from './progress.js';
import { rightsFor } from './rights.js';
import { RobotsGate } from './robots.js';
import { chooseSearchProvider } from './search.js';
import { matchSeeds, SEEDS, wikipediaArticleToApi } from './seeds.js';
import { cleanDocc, cleanMdn, resolveMdbook, type TransformedDocument, titleFromMarkdown, wikipediaExtractToMarkdown } from './transforms.js';
import {
  type Budget,
  type CorpusBuilderOptions,
  type CorpusOutline,
  DEFAULT_BUDGET,
  type FetchTarget,
  type KnowledgeObserver,
  type PreparedCorpus,
  type PrepareArgs,
  type Reference,
  type SearchProvider,
  SILENT_KNOWLEDGE_OBSERVER,
} from './types.js';

export const KNOWLEDGE_USER_AGENT = 'PenAcademyBot/0.1 (+https://pen.academy/bot; corpus builder for tutoring)';
const PRODUCT_TOKEN = 'PenAcademyBot';
const MIN_DOCUMENT_CHARS = 200;
const MAX_EXCERPT_CHARS = 300;
const MAX_EVAL_TITLES = 40;
const MAX_CONSECUTIVE_SEARCH_FAILURES = 3;
const MEDIA_EXT = /\.(pdf|zip|gz|tgz|tar|bz2|7z|rar|png|jpe?g|gif|svg|webp|ico|bmp|mp4|mp3|wav|ogg|mov|avi|webm|exe|dmg|pkg|iso|jar|woff2?|ttf|otf|css|js|mjs|wasm|xml|rss|atom)$/i;

interface Job extends FetchTarget {
  kind: 'source' | 'reference';
  rights: SourceRights;
}

/**
 * Topic-miss corpus builder (ADR-0009): seed → outline → discover → fetch →
 * rights → emit (streamed into Onten as each document lands) → evalset.
 * `prepare()` resolves on Onten's interactive promise; `background` finishes
 * the pack.
 */
export class CorpusBuilder {
  private readonly observer: KnowledgeObserver;
  private readonly budget: Budget;
  private readonly search: SearchProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CorpusBuilderOptions) {
    this.observer = opts.observer ?? SILENT_KNOWLEDGE_OBSERVER;
    this.budget = { ...DEFAULT_BUDGET, ...opts.budget };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.search = opts.search ?? chooseSearchProvider(process.env, { fetchImpl: this.fetchImpl, observer: this.observer });
  }

  prepare(args: PrepareArgs): Promise<PreparedCorpus> {
    const run = new CorpusRun(this.opts, this.observer, this.budget, this.search, this.fetchImpl, args);
    return run.start();
  }
}

class CorpusRun {
  private readonly topic: string;
  private readonly normalized: string;
  private readonly language: string;
  private readonly progress: ProgressReporter;
  private readonly signal: AbortSignal;
  private readonly fetchAbort = new AbortController();
  private readonly fetchSignal: AbortSignal;
  private readonly throttle: HostThrottle;
  private readonly fetcher: Fetcher;
  private readonly queue: FetchQueue<Job>;
  private readonly now: () => number;
  private readonly seen = new Set<string>();
  private readonly hostCounts = new Map<string, number>();
  private readonly references: Reference[] = [];
  private readonly documentTitles: string[] = [];
  private resolveOutline: (o: CorpusOutline) => void = () => undefined;
  private readonly outlinePromise = new Promise<CorpusOutline>((resolve) => {
    this.resolveOutline = resolve;
  });
  private outline: CorpusOutline | null = null;
  private compilation: ProgressiveCompilation | null = null;
  private emitChain: Promise<unknown> = Promise.resolve();
  private planned = 0;
  private fetched = 0;
  private skipped = 0;
  private searchesDone = 0;
  private searchesPlanned = 0;
  private ready = false;
  private failed = false;
  private readonly startedAt: number;

  constructor(
    private readonly opts: CorpusBuilderOptions,
    private readonly observer: KnowledgeObserver,
    private readonly budget: Budget,
    private readonly search: SearchProvider,
    fetchImpl: typeof fetch,
    private readonly args: PrepareArgs,
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.signal = args.signal;
    this.fetchSignal = AbortSignal.any([args.signal, this.fetchAbort.signal]);
    const title = args.resolution.title.trim() || args.resolution.canonicalKnowledgeId;
    this.topic = title;
    this.normalized = normalizeTopic(title) || title.toLowerCase();
    this.language = args.resolution.canonicalKnowledgeId.split('.')[0] || 'en';
    this.progress = new ProgressReporter(args.onProgress);
    const userAgent = opts.userAgent ?? KNOWLEDGE_USER_AGENT;
    this.throttle = new HostThrottle(budget.perHostGapMs, this.now);
    const robots = new RobotsGate({ fetchImpl, userAgent, productToken: PRODUCT_TOKEN, timeoutMs: Math.min(5_000, budget.timeoutMs), observer });
    this.fetcher = new Fetcher({ fetchImpl, userAgent, robots, throttle: this.throttle, budget, observer, signal: this.fetchSignal });
    this.queue = new FetchQueue<Job>({ concurrency: budget.concurrency, throttle: this.throttle, run: (job) => this.handle(job), signal: this.fetchSignal, observer });
  }

  async start(): Promise<PreparedCorpus> {
    const { resolution } = this.args;
    if (this.signal.aborted) throw abortError();
    this.observer.event('knowledge.prepare_start', { topic: this.topic, ckid: resolution.canonicalKnowledgeId, domain: resolution.domainBoundary, search: this.search.name });
    this.report('resolving', 0.02, `Setting up a workspace for ${this.topic}…`);

    const compilation = this.opts.compiler.startProgressiveCompilation({
      requestId: randomUUID(),
      hostId: this.opts.hostId ?? 'pen',
      canonicalKnowledgeId: resolution.canonicalKnowledgeId,
      title: this.topic,
      scope: { conceptOrTopicBoundary: this.topic, language: this.language, locale: this.opts.locale ?? 'en-US', domainBoundary: resolution.domainBoundary },
      policy: this.opts.policy.expansion,
    });
    this.compilation = compilation;
    const unsubscribe = compilation.onProgress((p) => this.onCompileProgress(p));
    this.signal.addEventListener('abort', () => {
      this.fetchAbort.abort();
      compilation.cancelBackground();
    }, { once: true });

    const seeds = matchSeeds(this.normalized, this.opts.seeds ?? SEEDS);
    for (const seed of seeds) {
      for (const target of seed.targets(this.topic)) {
        this.enqueue({ url: target.url, title: target.title, origin: 'seed', label: seed.label, seedId: seed.id, snippet: null, transform: target.transform, api: target.api ?? false, priority: seed.priority });
      }
    }
    this.observer.event('knowledge.seeds', { seeds: seeds.map((s) => s.id), targets: this.planned });
    this.report('outlining', 0.05, `Sketching a curriculum for ${this.topic}…`);

    const produced = this.produce(seeds.map((s) => s.label));
    const background = this.runBackground(produced, compilation).finally(unsubscribe);

    let receipt: ProvisionalReceipt;
    try {
      receipt = await raceAbort(compilation.interactive, this.signal);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    this.ready = true;
    const remaining = Math.max(0, this.planned - this.fetched - this.skipped);
    this.report('ready', READY_FRACTION, remaining > 0 ? `Ready to start · ${this.fetched} sources read, ${remaining} more on the way` : `Ready to start · ${this.fetched} sources read`);
    this.observer.event('knowledge.interactive', { packId: receipt.packId, units: receipt.unitCount, fetched: this.fetched, planned: this.planned, ms: this.now() - this.startedAt });
    return { packId: receipt.packId, provisional: true, background, outline: this.outlinePromise, references: this.references };
  }

  // ── producers: outline → candidate URLs → search ──────────────────────────
  private async produce(seedLabels: string[]): Promise<void> {
    try {
      const outline = await this.requestOutlineSafely(seedLabels);
      this.outline = outline;
      this.resolveOutline(outline);
      this.observer.event('knowledge.outline', { curriculum: outline.curriculum.length, queries: outline.queries.length, candidateUrls: outline.candidateUrls.length });
      outline.candidateUrls.forEach((url, i) => {
        this.enqueue({ url, title: null, origin: 'outline', label: hostLabel(url), seedId: null, snippet: null, transform: 'none', api: false, priority: 10 + i });
      });
      if (this.search.name !== 'none' && outline.queries.length > 0) await this.discover(outline.queries);
      this.report('discovering', 0.25, `Found ${this.planned} sources · preparing the first lesson`);
    } catch (error) {
      if (!this.signal.aborted && !isAbortError(error)) this.observer.error('knowledge.discover', error, { topic: this.topic });
      if (!this.outline) {
        this.outline = heuristicOutline(this.topic);
        this.resolveOutline(this.outline);
      }
    } finally {
      this.queue.close();
    }
  }

  private async requestOutlineSafely(seedLabels: string[]): Promise<CorpusOutline> {
    try {
      return await requestOutline(this.opts.model, { topic: this.topic, domainBoundary: this.args.resolution.domainBoundary, band: 'beginner', seedLabels, language: this.language }, `knowledge-outline:${this.args.resolution.canonicalKnowledgeId}`, this.signal);
    } catch (error) {
      if (this.signal.aborted || isAbortError(error)) throw error;
      this.observer.error('knowledge.outline', error, { topic: this.topic });
      return heuristicOutline(this.topic);
    }
  }

  private async discover(queries: string[]): Promise<void> {
    const list = queries.slice(0, this.budget.maxSearches);
    this.searchesPlanned = list.length;
    this.report('discovering', 0.12, `Searching the web for ${this.topic}…`);
    let cursor = 0;
    let consecutiveFailures = 0;
    let rank = 0;
    const worker = async () => {
      for (;;) {
        if (this.signal.aborted || consecutiveFailures >= MAX_CONSECUTIVE_SEARCH_FAILURES) return;
        const query = list[cursor];
        cursor += 1;
        if (query === undefined) return;
        try {
          const hits = await this.search.search({ query, maxResults: this.budget.resultsPerSearch, signal: this.signal });
          consecutiveFailures = 0;
          for (const hit of hits) {
            rank += 1;
            this.enqueue({ url: hit.url, title: hit.title || null, origin: 'search', label: hostLabel(hit.url), seedId: null, snippet: hit.snippet || null, transform: 'none', api: false, priority: 20 + rank });
          }
          this.observer.event('knowledge.search', { provider: this.search.name, query, hits: hits.length });
        } catch (error) {
          if (this.signal.aborted || isAbortError(error)) return;
          consecutiveFailures += 1;
          this.observer.error('knowledge.search', error, { provider: this.search.name, query });
        } finally {
          this.searchesDone += 1;
          this.report('discovering', 0.12 + 0.13 * (this.searchesDone / Math.max(1, this.searchesPlanned)), `Searching the web · ${this.searchesDone} of ${this.searchesPlanned} searches · ${this.planned} sources found`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.budget.searchConcurrency, list.length) }, worker));
  }

  // ── enqueue with rights, dedupe, SSRF and budget guards ───────────────────
  private enqueue(target: FetchTarget): void {
    let url = normalizeUrl(target.url);
    if (!url) return;
    const api = wikipediaArticleToApi(url);
    if (api) {
      url = api;
      target = { ...target, transform: 'wikipedia-extract', api: true };
    }
    if (!isFetchable(url)) {
      this.observer.event('knowledge.url_rejected', { url });
      return;
    }
    if (this.seen.has(url)) return;
    this.seen.add(url);
    const rights = rightsFor(url);
    if (!rights.ingestionAllowed) {
      this.reference({ ...target, url }, rights);
      return;
    }
    if (target.origin !== 'seed') {
      const host = hostOf(url);
      const count = this.hostCounts.get(host) ?? 0;
      if (count >= this.budget.maxPagesPerHost) {
        this.observer.event('knowledge.host_budget', { host, url });
        return;
      }
      this.hostCounts.set(host, count + 1);
    }
    if (this.planned >= this.budget.maxPages) {
      this.observer.event('knowledge.page_budget', { url, maxPages: this.budget.maxPages });
      return;
    }
    this.planned += 1;
    this.queue.push({ ...target, url, kind: 'source', rights });
  }

  /** Blocked sources are cited, never ingested: URL + ≤ 300-char excerpt (search snippet, else one bounded fetch). */
  private reference(target: FetchTarget, rights: SourceRights): void {
    if (target.snippet) {
      this.addReference({ url: target.url, title: target.title ?? hostLabel(target.url), excerpt: excerpt(target.snippet), license: rights.license });
      return;
    }
    if (this.planned >= this.budget.maxPages) return;
    this.planned += 1;
    this.queue.push({ ...target, kind: 'reference', rights, priority: target.priority + 100 });
  }

  private addReference(reference: Reference): void {
    this.references.push(reference);
    this.observer.event('knowledge.reference', { url: reference.url, license: reference.license });
  }

  // ── consumer: fetch → markdown → rights → emit ─────────────────────────────
  private async handle(job: Job): Promise<void> {
    const outcome = await this.fetcher.get(job.url, { api: job.api });
    if (!outcome.ok) {
      this.skipped += 1;
      this.observer.event('knowledge.page_skipped', { url: job.url, reason: outcome.reason, ...(outcome.status ? { status: outcome.status } : {}) });
      this.reportFetch(job);
      return;
    }
    const page = outcome.page;
    const converted = await this.toMarkdown(job, page);
    const title = converted?.title ?? job.title ?? hostLabel(page.finalUrl);
    // Redirects can land on a different host: re-evaluate rights on the final URL.
    const rights = page.finalUrl === job.url ? job.rights : rightsFor(page.finalUrl);
    if (job.kind === 'reference' || !rights.ingestionAllowed) {
      this.addReference({ url: page.finalUrl, title, excerpt: excerpt(converted?.markdown ?? page.body), license: rights.license });
      this.skipped += 1;
      this.reportFetch(job);
      return;
    }
    if (!converted || converted.markdown.length < MIN_DOCUMENT_CHARS) {
      this.skipped += 1;
      this.observer.event('knowledge.page_skipped', { url: job.url, reason: 'empty', chars: converted?.markdown.length ?? 0 });
      this.reportFetch(job);
      return;
    }
    const document: SourceDocument = {
      sourceId: `src_${sha(page.finalUrl)}`,
      url: page.finalUrl,
      title,
      mediaType: 'text/markdown',
      text: converted.markdown,
      rights,
      observedAt: this.now(),
    };
    await this.emit(document);
    this.fetched += 1;
    if (this.documentTitles.length < MAX_EVAL_TITLES) this.documentTitles.push(title);
    this.observer.event('knowledge.page', { url: page.finalUrl, origin: job.origin, chars: converted.markdown.length, truncated: page.truncated, license: rights.license });
    this.reportFetch(job);
  }

  /** Documents reach Onten strictly in arrival order, one at a time. */
  private emit(document: SourceDocument): Promise<void> {
    const compilation = this.compilation;
    if (!compilation) return Promise.resolve();
    const add = this.emitChain.then(() => compilation.addSource(document));
    this.emitChain = add.catch(() => undefined);
    return add;
  }

  private async toMarkdown(job: Job, page: FetchedPage): Promise<TransformedDocument | null> {
    const body = page.body;
    const looksHtml = page.contentType.includes('html') || (!page.contentType && /^\s*<(!doctype|html|head|body)/i.test(body));
    switch (job.transform) {
      case 'wikipedia-extract':
        return wikipediaExtractToMarkdown(body);
      case 'docc':
        return cleanDocc(body);
      case 'mdn':
        return cleanMdn(body);
      case 'mdbook':
        return resolveMdbook(body, page.finalUrl, { fetchText: (url) => this.fetchInclude(url) });
      default:
        if (looksHtml) return htmlToMarkdown(body);
        if (page.contentType.includes('json')) return null;
        return { title: titleFromMarkdown(body), markdown: body.trim() };
    }
  }

  private async fetchInclude(url: string): Promise<string | null> {
    const outcome = await this.fetcher.get(url, { api: false, countsTowardBudget: false });
    return outcome.ok ? outcome.page.body : null;
  }

  // ── background: drain → evalset → finishSources → qualified ───────────────
  private async runBackground(produced: Promise<void>, compilation: ProgressiveCompilation): Promise<QualifiedPackReference | null> {
    const budgetTimer = setTimeout(() => {
      this.observer.event('knowledge.background_budget', { ms: this.budget.backgroundMs, fetched: this.fetched, planned: this.planned });
      this.fetchAbort.abort();
    }, this.budget.backgroundMs);
    try {
      await produced;
      await this.queue.done;
      if (this.signal.aborted) {
        compilation.cancelBackground();
        return null;
      }
      if (this.fetched === 0) {
        this.observer.event('knowledge.no_sources', { planned: this.planned, skipped: this.skipped, references: this.references.length });
        compilation.finishSources();
        return await compilation.background;
      }
      const evaluation = await this.evaluate();
      if (!this.ready) this.report('compiling', 0.8, `Verifying the knowledge pack · ${this.fetched} sources`);
      compilation.finishSources(evaluation);
      const reference = await compilation.background;
      if (reference) {
        this.report('qualified', 1, `Knowledge pack verified · ${this.fetched} sources`);
        this.observer.event('knowledge.qualified', { packId: reference.packId, units: reference.unitCount, sources: this.fetched, skipped: this.skipped, references: this.references.length, ms: this.now() - this.startedAt });
      } else if (!this.signal.aborted) {
        this.observer.event('knowledge.qualification_failed', { sources: this.fetched, skipped: this.skipped });
      }
      return reference;
    } catch (error) {
      if (!this.signal.aborted && !isAbortError(error)) this.observer.error('knowledge.background', error, { topic: this.topic });
      compilation.cancelBackground();
      return null;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  private async evaluate(): Promise<Pack['evaluation']> {
    const curriculum = this.outline?.curriculum ?? heuristicOutline(this.topic).curriculum;
    try {
      const evaluation = await requestEvaluation(this.opts.model, { topic: this.topic, curriculum, documentTitles: this.documentTitles }, `knowledge-evalset:${this.args.resolution.canonicalKnowledgeId}`, this.signal);
      this.observer.event('knowledge.evalset', { development: evaluation.development.length, negative: evaluation.negative.length });
      return evaluation;
    } catch (error) {
      if (this.signal.aborted || isAbortError(error)) throw error;
      this.observer.error('knowledge.evalset', error, { topic: this.topic });
      return heuristicEvaluation(this.topic, curriculum);
    }
  }

  // ── progress ──────────────────────────────────────────────────────────────
  private report(stage: PreparationProgress['stage'], fraction: number, status: string): void {
    if (this.failed) return;
    this.progress.report({ stage, fraction, status, sourcesFound: this.planned, sourcesFetched: this.fetched });
  }

  private reportFetch(job: Job): void {
    if (this.ready) return; // the room owns the Preparing screen after the interactive pack; only the final line follows
    const done = this.fetched + this.skipped;
    const planned = Math.max(this.planned, 6);
    const fraction = 0.25 + 0.5 * (done / planned);
    const status = this.fetched === 1 && job.origin === 'seed' ? `Reading ${job.label}…` : `Reading ${job.label} · ${this.fetched} of ${this.planned} sources`;
    this.report('fetching', fraction, status);
  }

  private onCompileProgress(p: CompileProgress): void {
    if (this.ready || p.phase !== 'provisional') return;
    this.report('compiling', 0.8, `Compiling the first lesson · ${p.unitsCompiled} units from ${p.sourcesReceived} sources`);
  }

  private fail(error: unknown): void {
    this.failed = true;
    const aborted = this.signal.aborted || isAbortError(error);
    if (!aborted) this.observer.error('knowledge.prepare', error, { topic: this.topic, fetched: this.fetched, planned: this.planned, skipped: this.skipped });
    this.progress.report({ stage: 'failed', fraction: this.progress.current?.fraction ?? 0, status: aborted ? 'Preparation cancelled' : `Couldn't prepare ${this.topic}: ${messageOf(error)}`, sourcesFound: this.planned, sourcesFetched: this.fetched });
    this.fetchAbort.abort();
    this.compilation?.cancelBackground();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function excerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_EXCERPT_CHARS ? clean : `${clean.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hostLabel(url: string): string {
  return hostOf(url).replace(/^www\./, '') || url;
}

/** Canonical form for dedupe: lower-case host, no fragment, no tracking params, no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(key)) u.searchParams.delete(key);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fc[0-9a-f]{2}:.*|\[?fe80:.*)$/i;

/** Model- and search-supplied URLs are untrusted: http(s) only, public hosts only, no media. */
export function isFetchable(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname;
  if (!host.includes('.') || PRIVATE_HOST.test(host)) return false;
  if (MEDIA_EXT.test(u.pathname)) return false;
  return true;
}
