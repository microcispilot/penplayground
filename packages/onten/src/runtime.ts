import { performance } from 'node:perf_hooks';
import {
  type AnswerContext,
  CONTEXT_BUDGET,
  type ContextResult,
  type ContextSpan,
  type ContextStatus,
  ONTEN_LATENCY_BUDGET_MS,
  type ProvisionalSource,
  type QueryInput,
  type RuntimeMetrics,
} from '@pen/contracts';
import MiniSearch from 'minisearch';
import type { PackStore } from './pack-store.js';
import { digest, estimateTokens } from './text.js';
import type {
  HostContextPolicy,
  KnowledgeUnit,
  LatencyReport,
  OntenClient,
  Pack,
  RuntimeConfiguration,
} from './types.js';

interface IndexedUnit {
  key: string;
  packId: string;
  packRevision: string;
  unit: KnowledgeUnit;
  title: string;
  text: string;
  intents: string;
}

/**
 * Everything the compiler prepares once so a query does not have to think: the
 * lexical index, the unit lookup and the document frequency of every term.
 */
interface CompiledIndex {
  index: MiniSearch<IndexedUnit>;
  byKey: Map<string, IndexedUnit>;
  /** term → how many units contain it. The selector's only input besides the question. */
  df: Map<string, number>;
  units: number;
}

/**
 * A remembered *selection* (CTX-MEMO-01). Never an answer, never a payload:
 * the units this question chose last time and the score each of them earned, so
 * a hit produces the very shape a full run produces. Re-admitted against the
 * live index on every hit, because "a stored selection is a candidate set,
 * never an admitted set".
 */
interface MemoEntry {
  units: Array<{ key: string; score: number }>;
  primaryKey: string | null;
  bestScore: number;
}

/**
 * Compiled indexes shared by every runtime in the process, keyed by exactly what
 * decides their content. A session builds a runtime per room; the packs behind
 * them are the same artifacts, compiled once and reused — which is the whole
 * "compile once, reuse many" economics, applied to the mock's own index.
 */
const INDEX_CACHE = new Map<string, CompiledIndex>();
const MAX_CACHED_INDEXES = 8;

/**
 * The Canonical Question Memo, shared by every runtime in the process — which is
 * the point of it: the 8,432nd learner to ask "what is a variable" is a
 * different session, and their turn is the one that must cost nothing. Keyed by
 * the pack signature and a bounded, non-sensitive question key, so a republished
 * pack is simply a different memory and no learner's state can ever key it.
 */
const MEMO = new Map<string, MemoEntry>();
const MEMO_CAPACITY = 20_000;

function lru<T>(map: Map<string, T>, key: string, value: T, capacity: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > capacity) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Test seam: a benchmark must be able to measure a cold build and a cold memo. */
export function resetRuntimeCaches(): void {
  INDEX_CACHE.clear();
  MEMO.clear();
}

/**
 * The selector's two bounds. A question is answered from the terms that
 * actually discriminate: the rarest ones, and never a term so common it matches
 * most of the corpus while a rarer one is available. This is what keeps the
 * candidate set — and so the answer — inside the latency budget as the corpus
 * grows; scoring every unit that happens to share the word "the" is what a
 * search engine does, and a memory does not.
 */
const MAX_QUERY_TERMS = 4;
const MAX_DF_FRACTION = 0.02;
const MIN_DF_CEILING = 50;

/** Latency samples kept for `latency()`; a long session is a few hundred queries. */
const LATENCY_WINDOW = 2_000;

/** How long a speculation stays useful, and how many may wait at once. */
const SPECULATION_TTL_MS = 10_000;
const SPECULATION_CAPACITY = 32;

/**
 * Mock Context Runtime. Faithful to the AnswerContext schema and to the status
 * transitions in onten/runtime/context/src/lib.rs: sufficient only when
 * applicable units exist and nothing is unresolved; score forced to 0 otherwise;
 * requiresComplete always downgrades to partial with `complete_coverage_proof`.
 *
 * It behaves like memory, not like a search engine: it answers only from what it
 * was given, it answers a repeated question from the selection it already made,
 * and it holds `ONTEN_LATENCY_BUDGET_MS` for every call. Ask it about something
 * it was never given and the honest answer is `missing`, never an invented one.
 */
export class MockContextRuntime implements OntenClient {
  private configuration: RuntimeConfiguration | null = null;
  private packs: Pack[] = [];
  private compiled: CompiledIndex | null = null;
  private packRefs: AnswerContext['packRefs'] = [];
  private qualifiedPacks = new Set<string>();
  private signatureOfPacks = '';
  private speculation = new Map<string, { at: number; result: ContextResult }>();
  private readonly latencies: number[] = [];
  private overBudgetCount = 0;
  private readonly processId = process.pid;
  private closed = false;

  constructor(private readonly store: PackStore) {}

  async configure(configuration: RuntimeConfiguration): Promise<boolean> {
    this.assertOpen();
    this.configuration = configuration;
    this.packs = (await Promise.all(configuration.packIds.map((id) => this.store.get(id)))).filter(
      (p): p is Pack => p !== null,
    );
    this.speculation.clear();
    // The pack references the payload carries are taken here, once. The store
    // hands out live objects and the compiler mutates them in place as a
    // background compile publishes, so reading them per query would put a
    // revision in `packRefs` that the frozen index behind `evidenceSpans` does
    // not have — one payload disagreeing with itself.
    this.packRefs = this.packs.map((p) => ({
      packId: p.packId,
      packRevision: p.packRevision,
      digest: p.digest,
    }));
    this.qualifiedPacks = new Set(this.packs.filter((p) => p.qualified).map((p) => p.packId));
    // A different pack set (or a republished revision) is a different memory:
    // the signature is part of every memo key, so nothing has to be invalidated.
    this.signatureOfPacks = this.signature();
    this.compiled = this.indexFor(this.signatureOfPacks);
    // False when a requested pack id was not in the store: the session would
    // answer `missing` to everything, and that must not be silent.
    return this.packs.length === configuration.packIds.length;
  }

  /** Hosts re-activate after a background compile publishes a new revision. */
  async refreshPacks(): Promise<void> {
    if (this.configuration) await this.configure(this.configuration);
  }

  /** What every `query` on this runtime has cost so far (p50/p95/max, in ms). */
  latency(): LatencyReport {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    return {
      count: sorted.length,
      p50: sorted.length === 0 ? 0 : at(0.5),
      p95: sorted.length === 0 ? 0 : at(0.95),
      max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
      overBudget: this.overBudgetCount,
      budgetMs: ONTEN_LATENCY_BUDGET_MS,
    };
  }

  /**
   * The signature that decides an index's content: which packs, at which
   * revision and digest. Hashed, because it prefixes every memo key and a
   * session with many packs would otherwise carry kilobytes of pack ids into
   * each one.
   */
  private signature(): string {
    return digest(
      this.packs
        .map((p) => `${p.packId}@${p.packRevision}#${p.digest}`)
        .sort()
        .join('|'),
    );
  }

  private indexFor(signature: string): CompiledIndex {
    const cached = INDEX_CACHE.get(signature);
    if (cached) {
      // Refresh recency so a topic being taught right now is not the one evicted.
      lru(INDEX_CACHE, signature, cached, MAX_CACHED_INDEXES);
      return cached;
    }
    const docs: IndexedUnit[] = [];
    const byKey = new Map<string, IndexedUnit>();
    const df = new Map<string, number>();
    for (const pack of this.packs) {
      for (const unit of pack.units) {
        const doc: IndexedUnit = {
          key: `${pack.packId}#${unit.id}`,
          packId: pack.packId,
          packRevision: pack.packRevision,
          unit,
          title: unit.title,
          text: unit.text,
          intents: unit.intents.join(' '),
        };
        docs.push(doc);
        byKey.set(doc.key, doc);
        for (const term of new Set(tokenize(`${doc.title} ${doc.intents} ${doc.text}`)))
          df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
    const index = new MiniSearch<IndexedUnit>({
      idField: 'key',
      fields: ['title', 'text', 'intents'],
      storeFields: ['key'],
      searchOptions: {
        boost: { title: 2.2, intents: 2.6 },
        // No fuzzy matching, and prefixes only for a long word.
        //
        // This is where the 20 ms went. Edit-distance expansion over 20,000
        // units is quadratic in the worst case and it dominated every query:
        // measured on one machine, p95 fell from 3.00 ms to 0.79 ms with fuzzy
        // off alone, and retrieval was 90% of the whole call. On CI — six times
        // slower — the same setting was the difference between a p95 of 31 ms
        // and the budget being met with room to spare.
        //
        // What it costs: a misspelt query term no longer finds its unit. The
        // prefix rule keeps the common half of that (plural and inflected
        // forms still match), and the honest answer for the rest is Onten's
        // own — a question about material it cannot match gets `partial` or
        // `missing`, never an invented `sufficient`.
        fuzzy: false,
        prefix: (term) => term.length > 6,
        combineWith: 'OR',
      },
    });
    index.addAll(docs);
    const compiled: CompiledIndex = { index, byKey, df, units: docs.length };
    lru(INDEX_CACHE, signature, compiled, MAX_CACHED_INDEXES);
    return compiled;
  }

  async speculate(input: QueryInput): Promise<boolean> {
    this.assertOpen();
    const result = await this.assemble(input, { speculative: true });
    // One utterance produces a speculation per caption revision, and only the
    // one the final transcript matches is ever consumed. Without a bound the
    // rest — each holding five span texts — stay for the life of the room.
    const now = Date.now();
    for (const [k, v] of this.speculation)
      if (now - v.at >= SPECULATION_TTL_MS) this.speculation.delete(k);
    lru(this.speculation, this.speculationKey(input), { at: now, result }, SPECULATION_CAPACITY);
    return result.context.status === 'sufficient';
  }

  async query(input: QueryInput): Promise<ContextResult> {
    this.assertOpen();
    const t0 = performance.now();
    const result = await this.answer(input);
    return this.stamp(result, performance.now() - t0);
  }

  private async answer(input: QueryInput): Promise<ContextResult> {
    const key = this.speculationKey(input);
    const spec = this.speculation.get(key);
    if (spec && Date.now() - spec.at < SPECULATION_TTL_MS) {
      this.speculation.delete(key);
      return {
        context: { ...spec.result.context, inputRevision: input.revision },
        metrics: {
          ...spec.result.metrics,
          assemblyNs: 0,
          speculationHit: true,
          speculationCandidatePresent: true,
          speculationPreparedNs: spec.result.metrics.assemblyNs,
          speculationInvalidated: false,
        },
      };
    }
    return this.assemble(input, {
      speculative: false,
      speculationInvalidated: spec !== undefined,
    });
  }

  /**
   * Every call is measured against the budget on the wall clock, which is what
   * the host paid: `assemblyNs` is the runtime's own view of assembly and is
   * zero on a speculation hit. `elapsedMs`, `budgetMs` and `overBudget` go into
   * the run manifest, and the host decides what to do about a breach.
   */
  private stamp(result: ContextResult, ms: number): ContextResult {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
    const overBudget = ms > ONTEN_LATENCY_BUDGET_MS;
    if (overBudget) this.overBudgetCount += 1;
    return {
      ...result,
      metrics: { ...result.metrics, elapsedMs: Number(ms.toFixed(3)), overBudget },
    };
  }

  async provisional(input: QueryInput, source: ProvisionalSource): Promise<AnswerContext> {
    this.assertOpen();
    const policy = this.policy();
    if (!policy.expansion.allowed || !source.rightsAllowed) {
      return this.emptyContext(input, 'missing', ['host_scope']);
    }
    const spans: ContextSpan[] = this.spansFromText(source, input.text).slice(
      0,
      CONTEXT_BUDGET.maxEvidenceSpans,
    );
    const context = this.package(input, {
      status: 'partial',
      spans,
      primary: null,
      packRefs: [],
      unresolved: ['reviewed_pack_coverage'],
      constraints: [
        'hedge_and_attribute_unverified_source',
        'not_eligible_for_graded_assessment',
        'offer_to_notify_when_reviewed_material_ready',
      ],
      score: 0,
    });
    return context;
  }

  async close(): Promise<void> {
    this.closed = true;
    // The compiled index and the memo belong to the process, not to this
    // runtime: drop the references, never the artifacts another room is
    // teaching from. Only the speculation buffer is this session's own.
    this.compiled = null;
    this.packs = [];
    this.packRefs = [];
    this.qualifiedPacks.clear();
    this.speculation.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) throw new Error('CTX-CLIENT-01 runtime: closed');
  }

  private policy(): HostContextPolicy {
    if (!this.configuration)
      throw new Error('CTX-CONFIG-01 runtime: configure() must run before query()');
    return this.configuration.policy;
  }

  private speculationKey(input: QueryInput): string {
    return `${input.principal.principalId}|${input.topic}|${input.text.trim().toLowerCase()}`;
  }

  /**
   * The shared memo key. Bounded and non-sensitive by construction: the pack
   * signature, the topic, the selection band (the principal's groups), the
   * shape the host asked for, and the question — never a principal id, never a
   * fact, never mastery state. "No student identifier, no mastery score, no
   * private state ever enters the shared key" (CTX-MEMO-01).
   *
   * The question is canonicalised only by case, punctuation and spacing — the
   * words stay, and they stay in order. A set of words is not a question:
   * "is the glaze firing hotter than the bisque firing" and the same words the
   * other way round want different evidence, and so do "should I open the kiln"
   * and "should I *not* open the kiln". Dropping order or stop words would hand
   * the second learner the first learner's selection, which is a wrong answer
   * arriving faster.
   */
  private memoKey(input: QueryInput): string {
    const band = [...input.principal.groups].sort().join('+');
    return [
      this.signatureOfPacks,
      input.topic,
      band,
      input.contentInstructions ?? '',
      input.requiresComplete ? 'complete' : '',
      input.tokenBudget ?? '',
      tokenize(input.text).join(' '),
    ].join('|');
  }

  /**
   * The question, reduced to the terms that discriminate.
   *
   * A learner speaks; they do not type a search box. "Sorry, one sec — um, why
   * do we divide by the square root of d?" carries four words the corpus has
   * never heard and five that answer the question, and the four must not be
   * what the selector looks for. A word the corpus does not know has a document
   * frequency of zero, which would make it the *rarest* word of all, so
   * ranking on frequency alone puts the noise first and evicts the signal: the
   * question comes back `missing`, which is the one lie this mock must never
   * tell.
   *
   * So: words the corpus knows come first, rarest of those first; words it does
   * not know are kept only to fill the remaining places, and only when nothing
   * better is left. Then the ceiling drops anything so common it would drag in
   * most of the corpus — but never the last term standing. Precomputed document
   * frequencies make all of this arithmetic rather than a scan, which is what
   * keeps the answer inside the latency budget.
   */
  private selectTerms(text: string, compiled: CompiledIndex): string[] {
    // A question of nothing but stop words still has its short words: "what
    // does R do" is about R, and `contentTerms` drops single characters.
    const terms = contentTerms(text);
    const usable = terms.length > 0 ? terms : shortTerms(text);
    if (usable.length === 0) return [];
    const df = (t: string) => compiled.df.get(t) ?? 0;
    const known = usable.filter((t) => df(t) > 0).sort((a, b) => df(a) - df(b));
    const unknown = usable.filter((t) => df(t) === 0);
    if (known.length === 0) return unknown.slice(0, MAX_QUERY_TERMS);
    const ceiling = Math.max(MIN_DF_CEILING, Math.floor(compiled.units * MAX_DF_FRACTION));
    const discriminating = known.filter((t) => df(t) <= ceiling);
    // Every known term is common: keep the rarest rather than answering from nothing.
    const chosen = discriminating.length > 0 ? discriminating : known.slice(0, 1);
    return chosen.slice(0, MAX_QUERY_TERMS);
  }

  private async assemble(
    input: QueryInput,
    opts: { speculative: boolean; speculationInvalidated?: boolean },
  ): Promise<ContextResult> {
    const policy = this.policy();
    const t0 = performance.now();
    const compiled = this.compiled;
    const spans: ContextSpan[] = [];
    let primary: KnowledgeUnit | null = null;
    let primaryPack: Pack | null = null;
    let bestScore = 0;
    let memoHit = false;
    const packRefs = this.packRefs;

    const tRetrieval0 = performance.now();
    const key = this.memoKey(input);
    const remembered = MEMO.get(key);
    // A remembered selection, re-admitted against the live index. Units that are
    // no longer there simply do not come back; if none do, the memo is stale and
    // the ordinary ladder runs.
    if (compiled && remembered) {
      const admitted = remembered.units
        .map((u) => ({ doc: compiled.byKey.get(u.key), score: u.score }))
        .filter((u): u is { doc: IndexedUnit; score: number } => u.doc !== undefined);
      if (admitted.length > 0) {
        memoHit = true;
        lru(MEMO, key, remembered, MEMO_CAPACITY);
        bestScore = remembered.bestScore;
        const primaryEntry =
          admitted.find((u) => u.doc.key === remembered.primaryKey) ??
          (admitted[0] as { doc: IndexedUnit; score: number });
        primary = primaryEntry.doc.unit;
        primaryPack = this.packs.find((p) => p.packId === primaryEntry.doc.packId) ?? null;
        for (const u of admitted.slice(0, CONTEXT_BUDGET.maxEvidenceSpans))
          spans.push(spanOf(u.doc, u.score, this.qualifiedPacks.has(u.doc.packId)));
      } else {
        MEMO.delete(key);
      }
    }

    if (!memoHit && compiled && compiled.byKey.size > 0) {
      const terms = this.selectTerms(input.text, compiled);
      const queryTerms = contentTerms(input.text);
      const hits = terms.length === 0 ? [] : compiled.index.search(terms.join(' ')).slice(0, 12);
      const chosen: Array<{ key: string; score: number }> = [];
      let primaryKey: string | null = null;
      for (const hit of hits) {
        const doc = compiled.byKey.get(String(hit.id));
        if (!doc) continue;
        // Absolute match quality: fraction of the query's content terms this unit matched.
        const matched = new Set(hit.terms.map((t) => t.toLowerCase()));
        const norm =
          queryTerms.length === 0
            ? 0
            : queryTerms.filter(
                (t) =>
                  matched.has(t) ||
                  [...matched].some((m) => m.length > 3 && (m.startsWith(t) || t.startsWith(m))),
              ).length / queryTerms.length;
        if (spans.length >= CONTEXT_BUDGET.maxEvidenceSpans) break;
        if (!primary) {
          primary = doc.unit;
          primaryPack = this.packs.find((p) => p.packId === doc.packId) ?? null;
          primaryKey = doc.key;
          bestScore = norm;
        }
        chosen.push({ key: doc.key, score: norm });
        spans.push(spanOf(doc, norm, this.qualifiedPacks.has(doc.packId)));
      }
      // Remember the selection, not the answer: the next learner asking this
      // question of this band skips retrieval and the selector entirely.
      if (chosen.length > 0)
        lru(MEMO, key, { units: chosen, primaryKey, bestScore }, MEMO_CAPACITY);
    }
    const retrievalNs = Math.round((performance.now() - tRetrieval0) * 1e6);

    // Sufficiency: coverage of query terms by the selected spans, blended with retrieval strength.
    const coverage = termCoverage(input.text, spans.map((s) => s.text).join('\n'));
    const score = spans.length === 0 ? 0 : Number((0.55 * coverage + 0.45 * bestScore).toFixed(3));
    const unresolved: string[] = [];
    let status: ContextStatus;
    if (spans.length === 0) {
      status = 'missing';
      unresolved.push('intent_not_qualified');
    } else if (spans.length < CONTEXT_BUDGET.minEvidenceSpans) {
      status = 'partial';
      unresolved.push('insufficient_evidence_spans');
    } else if (score < policy.sufficiencyThreshold) {
      status = 'partial';
      unresolved.push('intent_not_qualified');
    } else {
      status = 'sufficient';
    }
    if (input.requiresComplete) {
      unresolved.push('complete_coverage_proof');
      if (status === 'sufficient') status = 'partial';
    }
    // Trim to the token budget; sufficient evidence is never truncated (HANDOFF), so drop the lowest spans instead.
    const budget = Math.min(
      input.tokenBudget ?? CONTEXT_BUDGET.maxRetrievedTokens,
      CONTEXT_BUDGET.maxRetrievedTokens,
    );
    while (
      spans.length > CONTEXT_BUDGET.minEvidenceSpans &&
      spans.reduce((n, s) => n + estimateTokens(s.text), 0) > budget
    ) {
      spans.pop();
    }
    if (spans.reduce((n, s) => n + estimateTokens(s.text), 0) > budget) {
      unresolved.push('context_budget');
      if (status === 'sufficient') status = 'partial';
    }

    const constraints = this.constraintsFor(input, primary);
    const context = this.package(input, {
      status,
      spans,
      primary:
        primary && primaryPack
          ? {
              packId: primaryPack.packId,
              packRevision: primaryPack.packRevision,
              id: primary.id,
              revision: primary.revision,
            }
          : null,
      packRefs,
      unresolved: [...new Set(unresolved)].sort(),
      constraints,
      score: status === 'sufficient' ? score : 0,
    });

    const assemblyNs = Math.round((performance.now() - t0) * 1e6);
    const metrics: RuntimeMetrics = {
      processId: this.processId,
      assemblyNs,
      retrievalNs,
      spans: [
        {
          stage: 'query',
          language: 'typescript',
          processId: this.processId,
          networkHops: 0,
          elapsedNs: retrievalNs,
        },
        {
          stage: 'sufficiency',
          language: 'typescript',
          processId: this.processId,
          networkHops: 0,
          elapsedNs: assemblyNs - retrievalNs,
        },
      ],
      denseEncoderUsed: false,
      baseSegments: this.packs.filter((p) => p.layer === 'shared_public_base').length,
      overlayShards: this.packs.filter((p) => p.layer !== 'shared_public_base').length,
      fusionNs: 0,
      speculationHit: false,
      speculationCandidatePresent: opts.speculative,
      speculationPreparedNs: 0,
      speculationInvalidated: opts.speculationInvalidated ?? false,
      speculationWastedNs: 0,
      retrievalBackend: 'minisearch-mock',
      retrievalStrategy: memoHit ? 'canonical_question_memo' : 'lexical_bm25_df_pruned',
      corpusCount: compiled?.byKey.size ?? 0,
      memoHit,
      // Filled in by `stamp`, which is the only place that knows the wall time.
      elapsedMs: 0,
      budgetMs: ONTEN_LATENCY_BUDGET_MS,
      overBudget: false,
    };
    return { context, metrics };
  }

  private constraintsFor(input: QueryInput, primary: KnowledgeUnit | null): string[] {
    const out: string[] = ['answer_only_from_admitted_evidence', 'cite_source_ids_exactly'];
    if (primary?.kind === 'misconception') out.push('address_misconception_before_advancing');
    if (input.contentInstructions) out.push(`content_instructions:${input.contentInstructions}`);
    return out;
  }

  private spansFromText(source: ProvisionalSource, query: string): ContextSpan[] {
    const paragraphs = source.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 40);
    const scored = paragraphs
      .map((p) => ({ p, s: termCoverage(query, p) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, CONTEXT_BUDGET.maxEvidenceSpans);
    return scored.map(({ p, s }, i) => ({
      packRef: '',
      unitId: `live:${source.sourceId}:${i}`,
      sourceId: source.sourceId,
      revision: source.revision,
      contentDigest: digest(p),
      text: p,
      attribution: source.attribution,
      evidenceTier: 'unverified_live_source',
      score: Number(s.toFixed(3)),
    }));
  }

  private emptyContext(
    input: QueryInput,
    status: ContextStatus,
    unresolved: string[],
  ): AnswerContext {
    return this.package(input, {
      status,
      spans: [],
      primary: null,
      packRefs: [],
      unresolved,
      // The payload with no evidence in it is the one where "answer only from
      // admitted evidence" matters most; dropping the constraint here would
      // leave the model its own judgement precisely when it has nothing.
      constraints: this.constraintsFor(input, null),
      score: 0,
    });
  }

  private package(
    input: QueryInput,
    args: {
      status: ContextStatus;
      spans: ContextSpan[];
      primary: AnswerContext['primaryUnit'];
      packRefs: AnswerContext['packRefs'];
      unresolved: string[];
      constraints: string[];
      score: number;
    },
  ): AnswerContext {
    const policy = this.policy();
    const modelContext = JSON.stringify({
      status: args.status,
      primaryUnitId: args.primary?.id ?? null,
      evidence: args.spans.map((s) => ({
        unitId: s.unitId,
        sourceId: s.sourceId,
        revision: s.revision,
        text: s.text,
        attribution: s.attribution,
        evidenceTier: s.evidenceTier,
      })),
      facts: input.facts.map((f) => ({ factId: f.factId, value: f.value })),
      derivedFacts: [],
      constraints: args.constraints,
      unresolved: args.unresolved,
      complete: false,
      expansionAllowed: policy.expansion.allowed,
      mayAuthorizeConsequentialDecision: args.status === 'sufficient',
    });
    return {
      schemaVersion: 1,
      inputRevision: input.revision,
      packRefs: args.packRefs,
      audienceScope: `host:${this.configuration?.hostId ?? 'pen'}/user:${input.principal.principalId}`,
      status: args.status,
      sufficiency: {
        policy: 'tutoring-standard@3',
        score: args.score,
        threshold: policy.sufficiencyThreshold,
        calibratedOn: 'dev-eval-mock',
        qualifiedOn: 'not_qualified',
      },
      primaryUnit: args.primary,
      typedFacts: input.facts,
      derivedFacts: [],
      evidenceSpans: args.spans,
      constraints: args.constraints,
      contextTokens: args.spans.reduce((n, s) => n + estimateTokens(s.text), 0),
      ontenSuppliedTokens: estimateTokens(modelContext),
      modelContext,
      unresolved: args.unresolved,
      expansionAllowed: policy.expansion.allowed,
      mayAuthorizeConsequentialDecision: args.status === 'sufficient',
      complete: false,
    };
  }
}

/**
 * A span from a pack that has not passed its qualification gate is not reviewed
 * material, whatever it is sitting in — it is what progressive first use served
 * early, and the contract tiers it accordingly (`03-progressive-first-use.yaml`).
 * Saying `reviewed_pack_source` there would be the payload claiming a review
 * that never happened.
 */
function spanOf(doc: IndexedUnit, score: number, qualified: boolean): ContextSpan {
  return {
    packRef: `${doc.packId}@${doc.packRevision}`,
    unitId: doc.unit.id,
    sourceId: doc.unit.sourceId,
    revision: doc.unit.revision,
    contentDigest: doc.unit.contentDigest,
    text: doc.unit.text,
    attribution: doc.unit.attribution,
    evidenceTier: qualified ? 'reviewed_pack_source' : 'unverified_live_source',
    score: Number(score.toFixed(3)),
  };
}

const STOP = new Set(
  'a an the of to in on for and or is are was were be been it this that these those what why how when where which who do does did i you we they my your our can could should would will with as at by from into about vs versus if then than so not'.split(
    ' ',
  ),
);

/** Fraction of the query's content terms that occur in the evidence text. */
export function termCoverage(query: string, evidence: string): number {
  const terms = [...new Set(tokenize(query).filter((t) => !STOP.has(t) && t.length > 1))];
  if (terms.length === 0) return 0;
  const hay = new Set(tokenize(evidence));
  let hit = 0;
  for (const t of terms) {
    if (hay.has(t)) hit++;
    else if (
      t.length >= 4 &&
      [...hay].some((h) => h.length >= 4 && (h.startsWith(t) || t.startsWith(h)))
    )
      hit++;
  }
  return hit / terms.length;
}

export function contentTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter((t) => !STOP.has(t) && t.length > 1))];
}

/**
 * The same thing without the length floor: a one-letter word is usually noise,
 * but when it is all the question has ("what is C used for") it is the question.
 */
function shortTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter((t) => !STOP.has(t)))];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
