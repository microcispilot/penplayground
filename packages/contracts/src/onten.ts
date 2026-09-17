import { z } from 'zod';

/**
 * Onten Context Runtime wire types. Field-for-field with
 * onten/contracts/context/schema-v1.json (18 required AnswerContext fields,
 * additionalProperties: false). Do not add fields here; Pen Playground's lesson
 * shaping rides on `contentInstructions` (ADR-0003).
 */
export const ContextStatus = z.enum(['sufficient', 'partial', 'conflict', 'stale', 'missing']);
export type ContextStatus = z.infer<typeof ContextStatus>;

export const EvidenceTier = z.enum([
  'reviewed_pack_source',
  'authoritative_live_fact',
  'unverified_live_source',
]);
export type EvidenceTier = z.infer<typeof EvidenceTier>;

export const Volatility = z.enum(['never_changing', 'slow_changing', 'fast_changing']);
export const FreshnessPolicy = z.enum(['immutable', 'max_age', 'must_revalidate', 'no_store']);
export const Currentness = z.enum(['historical', 'bounded_age', 'strict_current']);

export const PackRef = z.object({
  packId: z.string(),
  packRevision: z.string(),
  digest: z.string(),
});
export type PackRef = z.infer<typeof PackRef>;

export const UnitRef = z.object({
  packId: z.string(),
  packRevision: z.string(),
  id: z.string(),
  revision: z.string(),
});
export type UnitRef = z.infer<typeof UnitRef>;

export const SufficiencyRecord = z.object({
  policy: z.string(),
  score: z.number(),
  threshold: z.number(),
  calibratedOn: z.string(),
  qualifiedOn: z.string(),
});

export const Validity = z.object({
  observedAt: z.number().int(),
  validUntil: z.number().int().nullable(),
  startTime: z.number().int().nullable(),
  endTime: z.number().int().nullable(),
  rank: z.string(),
});
export const Provenance = z.object({
  authorityRef: z.string(),
  sourceRevisionOrValidator: z.string(),
});

export const FactValue = z.object({
  factId: z.string(),
  dimensions: z.record(z.string(), z.string()),
  value: z.unknown(),
  sharingScope: z.string(),
  volatility: Volatility,
  validity: Validity,
  freshnessPolicy: FreshnessPolicy,
  maxAgeMs: z.number().int().nullable(),
  provenance: Provenance,
  requiredCurrentness: Currentness,
});
export type FactValue = z.infer<typeof FactValue>;

export const DerivedFact = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  computedBy: z.string(),
  sourceFactIds: z.array(z.string()),
});

export const ContextSpan = z.object({
  packRef: z.string(),
  unitId: z.string(),
  sourceId: z.string(),
  revision: z.string(),
  contentDigest: z.string(),
  text: z.string(),
  attribution: z.string(),
  evidenceTier: EvidenceTier,
  score: z.number(),
});
export type ContextSpan = z.infer<typeof ContextSpan>;

export const AnswerContext = z
  .object({
    schemaVersion: z.number().int(),
    inputRevision: z.string(),
    packRefs: z.array(PackRef),
    audienceScope: z.string(),
    status: ContextStatus,
    sufficiency: SufficiencyRecord,
    primaryUnit: UnitRef.nullable(),
    typedFacts: z.array(FactValue),
    derivedFacts: z.array(DerivedFact),
    evidenceSpans: z.array(ContextSpan),
    constraints: z.array(z.string()),
    contextTokens: z.number().int().nonnegative(),
    ontenSuppliedTokens: z.number().int().nonnegative(),
    /** Rendered JSON string handed to the model verbatim as a separate user message. */
    modelContext: z.string(),
    unresolved: z.array(z.string()),
    expansionAllowed: z.boolean(),
    mayAuthorizeConsequentialDecision: z.boolean(),
    complete: z.boolean(),
  })
  .strict();
export type AnswerContext = z.infer<typeof AnswerContext>;

export const PrincipalSnapshot = z.object({
  principalId: z.string(),
  revision: z.string(),
  validUntil: z.number().int(),
  groups: z.array(z.string()),
  assurance: z.string(),
});

export const QueryInput = z
  .object({
    text: z.string(),
    revision: z.string(),
    topic: z.string(),
    principal: PrincipalSnapshot,
    facts: z.array(FactValue),
    at: z.number().int(),
    requiresComplete: z.boolean(),
    consequential: z.boolean(),
    tokenBudget: z.number().int().nullable(),
    /** Ahead of spec: Pen Playground shape requests, e.g. "lesson-plan:v1", "answer:v1". */
    contentInstructions: z.string().nullable(),
  })
  .strict();
export type QueryInput = z.infer<typeof QueryInput>;

export const StageSpan = z.object({
  stage: z.string(),
  language: z.string(),
  processId: z.number().int(),
  networkHops: z.number().int(),
  elapsedNs: z.number().int(),
});

export const RuntimeMetrics = z.object({
  processId: z.number().int(),
  assemblyNs: z.number().int(),
  retrievalNs: z.number().int(),
  spans: z.array(StageSpan),
  denseEncoderUsed: z.boolean(),
  baseSegments: z.number().int(),
  overlayShards: z.number().int(),
  fusionNs: z.number().int(),
  speculationHit: z.boolean(),
  speculationCandidatePresent: z.boolean(),
  speculationPreparedNs: z.number().int(),
  speculationInvalidated: z.boolean(),
  speculationWastedNs: z.number().int(),
  retrievalBackend: z.string(),
  retrievalStrategy: z.string(),
  corpusCount: z.number().int(),
});
export type RuntimeMetrics = z.infer<typeof RuntimeMetrics>;

export const ContextResult = z.object({ context: AnswerContext, metrics: RuntimeMetrics });
export type ContextResult = z.infer<typeof ContextResult>;

export const ProvisionalSource = z.object({
  sourceClass: z.string(),
  sourceId: z.string(),
  revision: z.string(),
  text: z.string(),
  attribution: z.string(),
  rightsAllowed: z.boolean(),
  observedAt: z.number().int(),
  validUntil: z.number().int(),
});
export type ProvisionalSource = z.infer<typeof ProvisionalSource>;

/** CTX-BUDGET-01 / performance-targets.yaml CTX-SMALL-MODEL-BUDGET. */
export const CONTEXT_BUDGET = {
  maxRetrievedTokens: 1500,
  maxOntenSuppliedTokens: 2000,
  minEvidenceSpans: 3,
  maxEvidenceSpans: 5,
  maxTypedFacts: 10,
  maxPrimaryUnits: 1,
} as const;

export const UnitKind = z.enum([
  'concept',
  'canonical_answer',
  'procedure',
  'rule_context',
  'code_pattern',
  'misconception',
  'exercise',
  'fact_cluster',
]);
export type UnitKind = z.infer<typeof UnitKind>;

export const Redistribution = z.enum(['allowed', 'derived_only', 'tenant_only', 'blocked']);
export type Redistribution = z.infer<typeof Redistribution>;

export const SourceRights = z.object({
  redistribution: Redistribution,
  authorizedAudiences: z.array(z.string()),
  ingestionAllowed: z.boolean(),
  license: z.string(),
  attribution: z.string(),
  policyRevision: z.string(),
  licenseText: z.string(),
});
export type SourceRights = z.infer<typeof SourceRights>;

/** A document the host hands to the compiler. Markdown or plain text only (Onten adapters). */
export const SourceDocument = z.object({
  sourceId: z.string(),
  url: z.string(),
  title: z.string(),
  mediaType: z.enum(['text/markdown', 'text/plain']),
  text: z.string(),
  rights: SourceRights,
  observedAt: z.number().int(),
});
export type SourceDocument = z.infer<typeof SourceDocument>;
