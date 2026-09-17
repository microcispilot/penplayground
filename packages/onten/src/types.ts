import type {
  AnswerContext,
  ContextResult,
  ProvisionalSource,
  QueryInput,
  SelectionBand,
  SourceDocument,
  UnitKind,
} from '@pen/contracts';

/**
 * Host-facing Onten surface (ADR-0003). Mirrors onten/sdk/context/index.ts
 * `ContextClient` exactly; Pen Academy adds `Registry` and `Compiler` which
 * mirror the registry contract and compiler/progressive.ts.
 */
export interface OntenClient {
  configure(configuration: RuntimeConfiguration): Promise<boolean>;
  query(input: QueryInput): Promise<ContextResult>;
  speculate(input: QueryInput): Promise<boolean>;
  provisional(input: QueryInput, source: ProvisionalSource): Promise<AnswerContext>;
  close(): Promise<void>;
}

export interface RuntimeConfiguration {
  hostId: string;
  policy: HostContextPolicy;
  /** Pack ids to activate for this session. */
  packIds: string[];
}

export interface HostContextPolicy {
  policyId: string;
  revision: string;
  allowedDomainsOrTopics: string[];
  crossTopicBehavior:
    | 'refuse'
    | 'ask_before_switch'
    | 'switch_if_pack_exists'
    | 'compile_if_allowed';
  expansion: {
    allowed: boolean;
    allowedSourceClasses: string[];
    maxInteractiveWaitMs: number;
    maxCostPerExpansion: number;
    backgroundCompileAfterGap: boolean;
    requiresUserNoticeWhenSlowPath: boolean;
    progressiveFirstUseEnabled: boolean;
    serveProvisionalContextBeforePackQualification: boolean;
  };
  sufficiencyThreshold: number;
}

// ── knowledge units and packs ────────────────────────────────────────────────
export interface KnowledgeUnit {
  id: string;
  revision: string;
  kind: UnitKind;
  /** Section heading or short title. */
  title: string;
  /** Verbatim text (extractive; Onten's reference profile preserves wording). */
  text: string;
  sourceId: string;
  sourceUrl: string;
  attribution: string;
  /** Intents (questions this unit answers) for memo/alias matching. */
  intents: string[];
  contentDigest: string;
}

export interface Pack {
  packId: string;
  packRevision: string;
  digest: string;
  layer: 'shared_public_base' | 'tenant_overlay' | 'audience_overlay' | 'user_overlay';
  canonicalKnowledgeId: string;
  scope: ScopeDescriptor;
  title: string;
  units: KnowledgeUnit[];
  sources: SourceDocument[];
  /** Development + negative evaluation questions required by the compile contract. */
  evaluation: { development: EvalCase[]; negative: EvalCase[] };
  qualified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EvalCase {
  question: string;
  /** Unit ids expected to be selected; empty for negatives. */
  expectedUnitIds: string[];
}

export interface ScopeDescriptor {
  conceptOrTopicBoundary: string;
  language: string;
  locale: string;
  domainBoundary: string;
}

// ── registry (semantic topic resolution) ─────────────────────────────────────
export interface TopicRequest {
  text: string;
  language: string;
  locale: string;
  band: SelectionBand;
}

export interface TopicResolution {
  canonicalKnowledgeId: string;
  /** Cleaned display title, e.g. "Swift fundamentals". */
  title: string;
  domainBoundary: string;
  match: 'hit' | 'partial' | 'miss';
  packId: string | null;
  /** A previously taught lesson for this scope and band, when one exists (Pen Academy memo extension). */
  lessonMemoId: string | null;
  /** Similarity score of the best candidate, 0–1. */
  score: number;
}

export interface OntenRegistry {
  resolveTopic(request: TopicRequest): Promise<TopicResolution>;
  listPacks(): Promise<
    Array<Pick<Pack, 'packId' | 'title' | 'canonicalKnowledgeId' | 'qualified' | 'updatedAt'>>
  >;
  getPack(packId: string): Promise<Pack | null>;
}

// ── compiler (progressive first use) ─────────────────────────────────────────
export interface CompileRequest {
  requestId: string;
  hostId: string;
  canonicalKnowledgeId: string;
  title: string;
  scope: ScopeDescriptor;
  policy: HostContextPolicy['expansion'];
}

export interface ProvisionalReceipt {
  status: 'partial' | 'missing';
  evidenceTier: 'unverified_live_source';
  attribution: string;
  mayAuthorizeConsequentialDecision: false;
  packId: string;
  unitCount: number;
  cost: number;
}

export interface QualifiedPackReference {
  packId: string;
  packRevision: string;
  digest: string;
  unitCount: number;
}

export interface ProgressiveCompilation {
  /** Resolves when the first useful provisional context exists (bounded by maxInteractiveWaitMs). */
  interactive: Promise<ProvisionalReceipt>;
  /** Resolves when the qualified pack exists; null if compilation was cancelled or failed. */
  background: Promise<QualifiedPackReference | null>;
  prepared(): QualifiedPackReference | null;
  cancelBackground(): void;
  /** The host streams documents in as it finds them. */
  addSource(document: SourceDocument): Promise<void>;
  /** Host signals no more sources will arrive; triggers qualification. */
  finishSources(evaluation?: Pack['evaluation']): void;
  /** Progress for the Preparing screen. */
  onProgress(listener: (p: CompileProgress) => void): () => void;
}

export interface CompileProgress {
  sourcesReceived: number;
  unitsCompiled: number;
  phase: 'collecting' | 'provisional' | 'qualifying' | 'qualified' | 'cancelled' | 'failed';
}

export interface OntenCompiler {
  startProgressiveCompilation(request: CompileRequest): ProgressiveCompilation;
}

// ── lesson memo (Pen Academy extension: session plans keyed by scope + band) ─
export interface LessonMemoEntry {
  id: string;
  canonicalKnowledgeId: string;
  band: SelectionBand;
  packId: string;
  packRevision: string;
  expertId: string;
  /** Serialized LessonPlan. */
  plan: unknown;
  /** Serialized lesson cues (the narration + board script), by segment. */
  cuesBySegment: unknown[][];
  timesReused: number;
  createdAt: number;
}

export interface LessonMemo {
  find(canonicalKnowledgeId: string, band: SelectionBand): Promise<LessonMemoEntry | null>;
  put(entry: Omit<LessonMemoEntry, 'id' | 'timesReused' | 'createdAt'>): Promise<LessonMemoEntry>;
  touch(id: string): Promise<void>;
}
