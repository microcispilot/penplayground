import { z } from 'zod';
import type { KnowledgeObserver, SearchHit, SearchProvider, SearchRequest } from './types.js';

export class SearchError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} search failed (${status}): ${detail}`);
    this.name = 'SearchError';
  }
}

interface AdapterOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Hosts never worth a search credit (paywalls, media). */
  excludeDomains?: string[];
}

const DEFAULT_EXCLUDES = [
  'youtube.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'pinterest.com',
  'quora.com',
];

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ── Tavily ───────────────────────────────────────────────────────────────────
/** docs.tavily.com/documentation/api-reference/endpoint/search (verified 2026-09-16). */
const TavilyResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().catch(''),
      url: z.string(),
      content: z.string().catch(''),
      score: z.number().nullable().catch(null),
    }),
  ),
});

export class TavilySearch implements SearchProvider {
  readonly name = 'tavily';
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: AdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    const { status, json, text } = await postJson(
      this.fetchImpl,
      'https://api.tavily.com/search',
      { authorization: `Bearer ${this.opts.apiKey}` },
      {
        query: request.query,
        search_depth: 'basic',
        topic: 'general',
        max_results: request.maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        exclude_domains: this.opts.excludeDomains ?? DEFAULT_EXCLUDES,
      },
      request.signal,
      this.opts.timeoutMs ?? 15_000,
    );
    if (status < 200 || status >= 300) throw new SearchError(this.name, status, text.slice(0, 200));
    const parsed = TavilyResponse.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, status, 'unexpected response shape');
    return parsed.data.results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
      score: r.score,
    }));
  }
}

// ── Exa ──────────────────────────────────────────────────────────────────────
/** docs.exa.ai/reference/search (verified 2026-09-16): x-api-key header, numResults, contents.text. */
const ExaResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullable().catch(null),
      url: z.string(),
      text: z.string().nullable().catch(null),
      score: z.number().nullable().catch(null),
    }),
  ),
});

export class ExaSearch implements SearchProvider {
  readonly name = 'exa';
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: AdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    const { status, json, text } = await postJson(
      this.fetchImpl,
      'https://api.exa.ai/search',
      { 'x-api-key': this.opts.apiKey },
      {
        query: request.query,
        type: 'auto',
        numResults: request.maxResults,
        excludeDomains: this.opts.excludeDomains ?? DEFAULT_EXCLUDES,
        contents: { text: { maxCharacters: 400 } },
      },
      request.signal,
      this.opts.timeoutMs ?? 15_000,
    );
    if (status < 200 || status >= 300) throw new SearchError(this.name, status, text.slice(0, 200));
    const parsed = ExaResponse.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, status, 'unexpected response shape');
    return parsed.data.results.map((r) => ({
      url: r.url,
      title: r.title ?? '',
      snippet: r.text ?? '',
      score: r.score,
    }));
  }
}

// ── SearXNG ──────────────────────────────────────────────────────────────────
/**
 * docs.searxng.org/dev/search_api.html (verified 2026-09-16): `GET /search?q=&format=json`
 * with `language`, `safesearch` and `categories` as query parameters. The JSON format must be
 * enabled server-side (`search.formats: [html, json]`), else the instance answers 403.
 * Result rows carry `url`, `title`, `content` and an aggregated `score` (unbounded, engine-summed).
 */
const SearxngResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().catch(''),
      content: z.string().nullable().catch(null),
      score: z.number().nullable().catch(null),
    }),
  ),
});

export interface SearxngOptions {
  /** Instance origin, e.g. `http://127.0.0.1:8080`; a trailing `/search` or `/` is tolerated. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Default 8 s: a self-hosted meta-search fans out to several engines and should answer well within it. */
  timeoutMs?: number;
  /** SearXNG language code (`en`, `en-US`, `de`, …). */
  language?: string;
  /** SearXNG has no exclude parameter; these hosts are dropped client-side. */
  excludeDomains?: string[];
}

function hostMatches(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export class SearxngSearch implements SearchProvider {
  readonly name = 'searxng';
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly language: string;
  private readonly excludeDomains: string[];

  constructor(opts: SearxngOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = `${opts.baseUrl.replace(/\/(?:search\/?)?$/, '')}/search`;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.language = opts.language ?? 'en';
    this.excludeDomains = opts.excludeDomains ?? DEFAULT_EXCLUDES;
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', request.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', this.language);
    url.searchParams.set('safesearch', '1');
    url.searchParams.set('categories', 'general');

    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
      status = res.status;
      text = await res.text();
    } catch (error) {
      // The caller's own cancellation must surface as such; everything else is a provider failure.
      if (request.signal.aborted) throw error;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new SearchError(this.name, 0, detail);
    }
    if (status === 403)
      throw new SearchError(this.name, status, 'json format disabled (search.formats)');
    if (status < 200 || status >= 300) throw new SearchError(this.name, status, text.slice(0, 200));
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SearchError(this.name, status, 'response is not JSON');
    }
    const parsed = SearxngResponse.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, status, 'unexpected response shape');

    // Engine-summed scores are unbounded; normalise against the best hit so callers see 0–1.
    const rows = parsed.data.results;
    const top = rows.reduce((m, r) => Math.max(m, r.score ?? 0), 0);
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.url) || hostMatches(r.url, this.excludeDomains)) continue;
      seen.add(r.url);
      hits.push({
        url: r.url,
        title: r.title,
        snippet: r.content ?? '',
        score: r.score === null ? null : top > 0 ? r.score / top : null,
      });
      if (hits.length >= request.maxResults) break;
    }
    return hits;
  }
}

// ── none ─────────────────────────────────────────────────────────────────────
/** Seeds and the outline's candidate URLs only; no web search. */
export class NoSearch implements SearchProvider {
  readonly name = 'none';
  async search(): Promise<SearchHit[]> {
    return [];
  }
}

/** Pick the adapter from the environment: a self-hosted SearXNG (free) wins, then Tavily, then Exa, else none. */
export function chooseSearchProvider(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; observer?: KnowledgeObserver } = {},
): SearchProvider {
  const fetchImpl = opts.fetchImpl;
  const searxng = env.SEARXNG_URL?.trim();
  if (searxng)
    return new SearxngSearch(fetchImpl ? { baseUrl: searxng, fetchImpl } : { baseUrl: searxng });
  const tavily = env.TAVILY_API_KEY?.trim();
  if (tavily)
    return new TavilySearch(fetchImpl ? { apiKey: tavily, fetchImpl } : { apiKey: tavily });
  const exa = env.EXA_API_KEY?.trim();
  if (exa) return new ExaSearch(fetchImpl ? { apiKey: exa, fetchImpl } : { apiKey: exa });
  opts.observer?.event('knowledge.search_provider', {
    provider: 'none',
    reason: 'no SEARXNG_URL, TAVILY_API_KEY or EXA_API_KEY',
  });
  return new NoSearch();
}
