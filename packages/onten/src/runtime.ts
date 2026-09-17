import { performance } from 'node:perf_hooks';
import {
  type AnswerContext,
  CONTEXT_BUDGET,
  type ContextResult,
  type ContextSpan,
  type ContextStatus,
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
 * Mock Context Runtime. Faithful to the AnswerContext schema and to the status
 * transitions in onten/runtime/context/src/lib.rs: sufficient only when
 * applicable units exist and nothing is unresolved; score forced to 0 otherwise;
 * requiresComplete always downgrades to partial with `complete_coverage_proof`.
 */
export class MockContextRuntime implements OntenClient {
  private configuration: RuntimeConfiguration | null = null;
  private packs: Pack[] = [];
  private index: MiniSearch<IndexedUnit> | null = null;
  private byKey = new Map<string, IndexedUnit>();
  private speculation = new Map<string, { at: number; result: ContextResult }>();
  private readonly processId = process.pid;
  private closed = false;

  constructor(private readonly store: PackStore) {}

  async configure(configuration: RuntimeConfiguration): Promise<boolean> {
    this.assertOpen();
    this.configuration = configuration;
    this.packs = (await Promise.all(configuration.packIds.map((id) => this.store.get(id)))).filter(
      (p): p is Pack => p !== null,
    );
    this.rebuildIndex();
    return true;
  }

  /** Hosts re-activate after a background compile publishes a new revision. */
  async refreshPacks(): Promise<void> {
    if (this.configuration) await this.configure(this.configuration);
  }

  private rebuildIndex(): void {
    const docs: IndexedUnit[] = [];
    this.byKey.clear();
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
        this.byKey.set(doc.key, doc);
      }
    }
    this.index = new MiniSearch<IndexedUnit>({
      idField: 'key',
      fields: ['title', 'text', 'intents'],
      storeFields: ['key'],
      searchOptions: {
        boost: { title: 2.2, intents: 2.6 },
        fuzzy: (term) => (term.length > 5 ? 0.2 : false),
        prefix: (term) => term.length > 3,
        combineWith: 'OR',
      },
    });
    this.index.addAll(docs);
  }

  async speculate(input: QueryInput): Promise<boolean> {
    this.assertOpen();
    const result = await this.assemble(input, { speculative: true });
    this.speculation.set(this.speculationKey(input), { at: Date.now(), result });
    return result.context.status === 'sufficient';
  }

  async query(input: QueryInput): Promise<ContextResult> {
    this.assertOpen();
    const key = this.speculationKey(input);
    const spec = this.speculation.get(key);
    if (spec && Date.now() - spec.at < 10_000) {
      this.speculation.delete(key);
      const t0 = performance.now();
      const context = { ...spec.result.context, inputRevision: input.revision };
      const residualNs = Math.round((performance.now() - t0) * 1e6);
      return {
        context,
        metrics: {
          ...spec.result.metrics,
          assemblyNs: residualNs,
          speculationHit: true,
          speculationCandidatePresent: true,
          speculationPreparedNs: spec.result.metrics.assemblyNs,
          speculationInvalidated: false,
        },
      };
    }
    return this.assemble(input, { speculative: false, speculationInvalidated: spec !== undefined });
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
    this.index = null;
    this.packs = [];
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

  private async assemble(
    input: QueryInput,
    opts: { speculative: boolean; speculationInvalidated?: boolean },
  ): Promise<ContextResult> {
    const policy = this.policy();
    const t0 = performance.now();
    const spans: ContextSpan[] = [];
    let primary: KnowledgeUnit | null = null;
    let primaryPack: Pack | null = null;
    let bestScore = 0;
    const packRefs = this.packs.map((p) => ({
      packId: p.packId,
      packRevision: p.packRevision,
      digest: p.digest,
    }));

    const tRetrieval0 = performance.now();
    if (this.index && this.byKey.size > 0) {
      const hits = this.index.search(input.text).slice(0, 12);
      const queryTerms = contentTerms(input.text);
      for (const hit of hits) {
        const doc = this.byKey.get(String(hit.id));
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
          bestScore = norm;
        }
        spans.push({
          packRef: `${doc.packId}@${doc.packRevision}`,
          unitId: doc.unit.id,
          sourceId: doc.unit.sourceId,
          revision: doc.unit.revision,
          contentDigest: doc.unit.contentDigest,
          text: doc.unit.text,
          attribution: doc.unit.attribution,
          evidenceTier: 'reviewed_pack_source',
          score: Number(norm.toFixed(3)),
        });
      }
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
      retrievalStrategy: 'lexical_bm25',
      corpusCount: this.byKey.size,
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
      constraints: [],
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
