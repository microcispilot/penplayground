import type {
  CostComponent,
  LeaveReason,
  ReuseKind,
  SessionTelemetry,
  StageName,
  StageSample,
} from '@pen/contracts';
import { ABANDON_ERROR_WINDOW_MS, STATS_SCHEMA_VERSION } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import { percentile } from '../telemetry.js';

/**
 * Rolling one session's recording ledger into rows SQL can group (ADR-0027).
 *
 * Pure, like `computeTelemetry` above it: the same ledger and the same session
 * record always give the same rows, so the derivation at session end, the
 * backfill over a year of ledgers, and a test on a fixture all agree. Nothing
 * here reads the database, the disk or the clock except through its arguments.
 *
 * The ledger stays the source of truth. Every row this produces is throwaway
 * and rebuildable, which is what lets `STATS_SCHEMA_VERSION` be a re-run
 * rather than a migration.
 */

/** Which cost component a stage's spend is attributed to. A stage with none never spent anything. */
const STAGE_COMPONENT: Partial<Record<StageName, CostComponent>> = {
  llm: 'llm',
  intent: 'intent',
  image: 'image',
  tts: 'tts',
  stt: 'stt',
  prepare: 'search',
  context: 'onten',
};

/** The card copy and the session picture, as `meta.ts` labels them. */
const CARD_PURPOSE = 'session_meta';
const THUMBNAIL_PURPOSE = 'session_thumbnail';

/** How the room was closed, when the caller knows. The backfill does not, and says so. */
/**
 * Why a room stopped. `shutdown` is the process going down under a live
 * lesson — a deploy, almost always — and it is kept apart from `idle`
 * because they mean opposite things about the learner: one walked away, the
 * other was interrupted by us.
 */
export type EndReason = 'host' | 'idle' | 'length_ceiling' | 'shutdown' | 'unknown';

export interface DeriveInput {
  telemetry: SessionTelemetry;
  record: SessionRecord;
  /** Entries the ledger held when this was derived; the backfill re-derives when it has grown. */
  ledgerEntries: number;
  /** `state.mode === 'complete'` when the room said so; otherwise inferred from the recap and the progress. */
  completed?: boolean | undefined;
  endReason?: EndReason | undefined;
  /** The host had analytics off: the row is still written, but per-person reports skip it. */
  hostOptedOut?: boolean | undefined;
  derivedAt: number;
}

/** A piece of memoised work this session either bought or was given. */
export interface WorkClaim {
  kind: ReuseKind;
  scopeKey: string;
  /** How many items — segments, sentences, one pack. */
  uses: number;
  savedUsd: number;
}

export interface DerivedSession {
  /** Column-for-column what `session_stats` holds; the repository inserts it as-is. */
  session: DerivedSessionRow;
  stages: DerivedStageRow[];
  errors: DerivedErrorRow[];
  /** Scopes this session generated: it may claim their origin if nobody has. */
  generated: Array<{ kind: ReuseKind; scopeKey: string }>;
  /** Scopes it took from someone else's work: one reuse link each. */
  reused: WorkClaim[];
}

export interface DerivedSessionRow {
  sessionId: string;
  schemaVersion: number;
  derivedAt: number;
  ledgerEntries: number;
  hostId: string;
  plan: string;
  expertId: string;
  language: string;
  band: string;
  domain: string;
  canonicalId: string | null;
  scopeKey: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  segmentsPlanned: number;
  segmentsReached: number;
  says: number;
  questions: number;
  interrupts: number;
  adsShown: number;
  adsSkipped: number;
  participants: number;
  interactions: number;
  stages: number;
  errors: number;
  completed: boolean;
  leaveReason: LeaveReason;
  progress: number;
  leftAtMs: number;
  lastStage: string | null;
  lastInteraction: string | null;
  adPlayingAtEnd: boolean;
  lastErrorCode: string | null;
  timeToFirstAudioMs: number | null;
  turnP50Ms: number | null;
  turnP95Ms: number | null;
  llmFirstTokenP50Ms: number | null;
  llmFirstTokenP95Ms: number | null;
  ttsFirstChunkP50Ms: number | null;
  ttsFirstChunkP95Ms: number | null;
  sttFinalP50Ms: number | null;
  sttFinalP95Ms: number | null;
  bargeInP50Ms: number | null;
  bargeInP95Ms: number | null;
  totalUsd: number;
  revenueUsd: number;
  llmUsd: number;
  intentUsd: number;
  imageUsd: number;
  ttsUsd: number;
  sttUsd: number;
  searchUsd: number;
  ontenUsd: number;
  llmCalls: number;
  intentCalls: number;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  ttsBytes: number;
  sttSeconds: number;
  searchRequests: number;
  packHit: boolean;
  intakeCacheHit: boolean;
  memoSegmentsReused: number;
  memoSegmentsGenerated: number;
  contextSpeculationHits: number;
  ttsSentencesReused: number;
  ttsSentencesGenerated: number;
  imageReused: boolean;
  cardReused: boolean;
  savedUsd: number;
  freshEquivalentUsd: number;
  hostOptedOut: boolean;
}

export interface DerivedStageRow {
  sessionId: string;
  stage: string;
  samples: number;
  ok: number;
  failed: number;
  reused: number;
  totalMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  usd: number;
  savedUsd: number;
  firstAtMs: number;
  lastAtMs: number;
}

export interface DerivedErrorRow {
  sessionId: string;
  code: string;
  stage: string | null;
  n: number;
  firstAtMs: number;
  lastAtMs: number;
}

const reusedSample = (s: StageSample): boolean => s.meta.reused === true;
const purposeOf = (s: StageSample): string | null =>
  typeof s.meta.purpose === 'string' ? s.meta.purpose : null;
const savedOf = (s: StageSample): number =>
  typeof s.meta.savedUsd === 'number' && Number.isFinite(s.meta.savedUsd) && s.meta.savedUsd > 0
    ? s.meta.savedUsd
    : 0;
const round = (n: number, places = 6): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const whole = (n: number | null): number | null =>
  n === null || !Number.isFinite(n) ? null : Math.round(n);

/**
 * The key each kind of memo is stored under, spelled the way the module that
 * owns it spells it, so two sessions that shared work produce the same string:
 *
 *  - `pack`    the canonical topic alone (`packages/onten` registry).
 *  - `lesson`, `card`, `picture` the lesson memo's scope, which the card and
 *    the picture deliberately share (ADR-0013, ADR-0021).
 *  - `voice`   the lesson voice store's path, which carries no language
 *    (`packages/voice/src/server/cache.ts` `lessonPath`).
 *
 * Null when the session never resolved to a canonical topic: there is no
 * scope, so there is nothing to have shared.
 */
export function scopeKeyFor(
  kind: ReuseKind,
  s: { canonicalId: string | null; band: string; expertId: string; language: string },
): string | null {
  if (!s.canonicalId) return null;
  switch (kind) {
    case 'pack':
      return s.canonicalId;
    case 'voice':
      return `${s.canonicalId}|${s.band}|${s.expertId}`;
    default:
      return `${s.canonicalId}|${s.band}|${s.expertId}|${s.language}`;
  }
}

export function deriveSession(input: DeriveInput): DerivedSession {
  const { telemetry: t, record } = input;
  const usd = (c: CostComponent) => round(t.cost.byComponent[c]?.usd ?? 0);
  const units = (
    c: CostComponent,
    u: 'tokens_in' | 'tokens_cached' | 'tokens_out' | 'bytes' | 'seconds' | 'requests',
  ) => t.cost.byComponent[c]?.units[u] ?? 0;

  const segmentsPlanned = record.segments;
  const segmentsReached = t.totals.segments;
  const progress =
    segmentsPlanned > 0 ? Math.min(1, round(segmentsReached / segmentsPlanned, 4)) : 0;

  const lastStage = t.stages.length > 0 ? (t.stages[t.stages.length - 1]?.stage ?? null) : null;
  const lastInteraction =
    t.interactions.length > 0 ? (t.interactions[t.interactions.length - 1]?.event ?? null) : null;

  // An ad that was shown and never reported finishing was still on screen when
  // the room closed. Both the player's own lifecycle and the two summary
  // events count, because a client that dies mid-ad sends neither.
  const shown = t.interactions.filter(
    (i) => i.event === 'ad_shown' || i.event === 'ad_started',
  ).length;
  const finished = t.interactions.filter(
    (i) =>
      i.event === 'ad_ended' ||
      i.event === 'ad_completed' ||
      i.event === 'ad_skipped' ||
      i.event === 'ad_error',
  ).length;
  const adPlayingAtEnd = shown > finished;

  const lastError = [...t.errors].reverse()[0] ?? null;
  const lastErrorCode =
    lastError && t.totals.durationMs - lastError.t <= ABANDON_ERROR_WINDOW_MS
      ? lastError.code
      : null;

  // `state.mode` is the honest answer and the room knows it. Without one — the
  // backfill, an older ledger — a recap plus every segment taught is as close
  // as the record can get.
  const completed =
    input.completed ?? (record.recap.length > 0 && segmentsPlanned > 0 && progress >= 1);
  const everAudible = t.latency.timeToFirstAudioMs !== null || t.totals.says > 0;

  const leaveReason: LeaveReason = completed
    ? 'completed'
    : input.endReason === 'length_ceiling'
      ? 'length_ceiling'
      : !everAudible
        ? 'never_started'
        : adPlayingAtEnd
          ? 'left_during_ad'
          : lastErrorCode !== null
            ? 'left_after_error'
            : segmentsReached > 0
              ? 'left_mid_segment'
              : input.endReason === 'idle'
                ? 'idle_timeout'
                : 'unknown';

  // Reuse of the card and the picture is not in `ReuseSummary` — those jobs run
  // beside the lesson, not inside it — so they are read off their own samples.
  const cardReused = t.stages.some(
    (s) => s.stage === 'llm' && purposeOf(s) === CARD_PURPOSE && reusedSample(s),
  );
  const cardGenerated = t.stages.some(
    (s) => s.stage === 'llm' && purposeOf(s) === CARD_PURPOSE && !reusedSample(s) && s.ok,
  );
  const imageSamples = t.stages.filter(
    (s) => s.stage === 'image' && purposeOf(s) === THUMBNAIL_PURPOSE,
  );
  const imageReused = imageSamples.some(reusedSample);
  const imageGenerated = imageSamples.some((s) => !reusedSample(s) && s.ok);

  const scope = {
    canonicalId: t.canonicalId,
    band: record.band,
    expertId: record.expertId,
    language: record.language,
  };

  const session: DerivedSessionRow = {
    sessionId: t.sessionId,
    schemaVersion: STATS_SCHEMA_VERSION,
    derivedAt: input.derivedAt,
    ledgerEntries: input.ledgerEntries,
    hostId: record.hostId,
    plan: t.plan,
    expertId: record.expertId,
    language: record.language,
    band: record.band,
    domain: record.domain,
    canonicalId: t.canonicalId,
    scopeKey: scopeKeyFor('lesson', scope),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs > 0 ? record.durationMs : t.totals.durationMs,
    segmentsPlanned,
    segmentsReached,
    says: t.totals.says,
    questions: t.totals.questions,
    interrupts: t.totals.interrupts,
    adsShown: t.totals.adsShown,
    adsSkipped: t.totals.adsSkipped,
    participants: t.totals.participants,
    interactions: t.interactions.length,
    stages: t.stages.length,
    errors: t.errors.length,
    completed,
    leaveReason,
    progress,
    leftAtMs: t.totals.durationMs,
    lastStage,
    lastInteraction,
    adPlayingAtEnd,
    lastErrorCode,
    timeToFirstAudioMs: whole(t.latency.timeToFirstAudioMs),
    turnP50Ms: whole(t.latency.questionToFirstAudioMs.p50),
    turnP95Ms: whole(t.latency.questionToFirstAudioMs.p95),
    llmFirstTokenP50Ms: whole(t.latency.llmFirstTokenMs.p50),
    llmFirstTokenP95Ms: whole(t.latency.llmFirstTokenMs.p95),
    ttsFirstChunkP50Ms: whole(t.latency.ttsFirstChunkMs.p50),
    ttsFirstChunkP95Ms: whole(t.latency.ttsFirstChunkMs.p95),
    sttFinalP50Ms: whole(t.latency.sttFinalMs.p50),
    sttFinalP95Ms: whole(t.latency.sttFinalMs.p95),
    bargeInP50Ms: whole(t.latency.bargeInMs.p50),
    bargeInP95Ms: whole(t.latency.bargeInMs.p95),
    totalUsd: round(t.cost.totalUsd),
    revenueUsd: round(t.cost.revenueUsd),
    llmUsd: usd('llm'),
    intentUsd: usd('intent'),
    imageUsd: usd('image'),
    ttsUsd: usd('tts'),
    sttUsd: usd('stt'),
    searchUsd: usd('search'),
    ontenUsd: usd('onten'),
    llmCalls: t.cost.byComponent.llm?.calls ?? 0,
    intentCalls: t.cost.byComponent.intent?.calls ?? 0,
    tokensIn: Math.round(units('llm', 'tokens_in')),
    tokensCached: Math.round(units('llm', 'tokens_cached')),
    tokensOut: Math.round(units('llm', 'tokens_out')),
    ttsBytes: Math.round(units('tts', 'bytes')),
    sttSeconds: round(units('stt', 'seconds'), 3),
    searchRequests: Math.round(units('search', 'requests')),
    packHit: t.reuse.packHit,
    intakeCacheHit: t.reuse.intakeCacheHit,
    memoSegmentsReused: t.reuse.memoSegmentsReused,
    memoSegmentsGenerated: t.reuse.memoSegmentsGenerated,
    contextSpeculationHits: t.reuse.contextSpeculationHits,
    ttsSentencesReused: t.reuse.ttsSentencesReused,
    ttsSentencesGenerated: t.reuse.ttsSentencesGenerated,
    imageReused,
    cardReused,
    savedUsd: round(t.reuse.savedUsd),
    freshEquivalentUsd: round(t.reuse.freshEquivalentUsd),
    hostOptedOut: input.hostOptedOut ?? false,
  };

  return {
    session,
    stages: deriveStages(t),
    errors: deriveErrors(t),
    generated: generatedScopes({
      scope,
      packGenerated: !t.reuse.packHit && t.canonicalId !== null,
      lessonGenerated: t.reuse.memoSegmentsGenerated > 0,
      voiceGenerated: t.reuse.ttsSentencesGenerated > 0,
      cardGenerated,
      imageGenerated,
    }),
    reused: reusedScopes(t, scope),
  };
}

function deriveStages(t: SessionTelemetry): DerivedStageRow[] {
  const byStage = new Map<string, StageSample[]>();
  for (const s of t.stages) {
    const list = byStage.get(s.stage);
    if (list) list.push(s);
    else byStage.set(s.stage, [s]);
  }
  const rows: DerivedStageRow[] = [];
  for (const [stage, samples] of byStage) {
    const durations = samples.map((s) => s.ms);
    const component = STAGE_COMPONENT[stage as StageName];
    rows.push({
      sessionId: t.sessionId,
      stage,
      samples: samples.length,
      ok: samples.filter((s) => s.ok).length,
      failed: samples.filter((s) => !s.ok).length,
      reused: samples.filter(reusedSample).length,
      totalMs: Math.round(durations.reduce((a, b) => a + b, 0)),
      p50Ms: whole(percentile(durations, 50)),
      p95Ms: whole(percentile(durations, 95)),
      maxMs: whole(Math.max(...durations)),
      // Attributed by component, not per sample: a cost line names what it
      // bought, not which timing it belonged to, and each component maps to
      // exactly one stage. A component that was billed without leaving a
      // stage sample therefore has nowhere to land here — `session_stats` is
      // the authoritative total, and this column is for "which stage costs
      // us the most", not for summing.
      usd: component ? round(t.cost.byComponent[component]?.usd ?? 0) : 0,
      savedUsd: round(samples.reduce((n, s) => n + savedOf(s), 0)),
      firstAtMs: Math.min(...samples.map((s) => s.t)),
      lastAtMs: Math.max(...samples.map((s) => s.t)),
    });
  }
  return rows.sort((a, b) => a.firstAtMs - b.firstAtMs || a.stage.localeCompare(b.stage));
}

function deriveErrors(t: SessionTelemetry): DerivedErrorRow[] {
  const byCode = new Map<string, DerivedErrorRow>();
  for (const e of t.errors) {
    const row = byCode.get(e.code);
    if (row) {
      row.n += 1;
      row.lastAtMs = Math.max(row.lastAtMs, e.t);
      row.firstAtMs = Math.min(row.firstAtMs, e.t);
    } else {
      byCode.set(e.code, {
        sessionId: t.sessionId,
        code: e.code,
        stage: e.stage,
        n: 1,
        firstAtMs: e.t,
        lastAtMs: e.t,
      });
    }
  }
  return [...byCode.values()].sort((a, b) => a.firstAtMs - b.firstAtMs);
}

type Scope = { canonicalId: string | null; band: string; expertId: string; language: string };

function generatedScopes(args: {
  scope: Scope;
  packGenerated: boolean;
  lessonGenerated: boolean;
  voiceGenerated: boolean;
  cardGenerated: boolean;
  imageGenerated: boolean;
}): Array<{ kind: ReuseKind; scopeKey: string }> {
  const out: Array<{ kind: ReuseKind; scopeKey: string }> = [];
  const add = (kind: ReuseKind, yes: boolean) => {
    const key = yes ? scopeKeyFor(kind, args.scope) : null;
    if (key) out.push({ kind, scopeKey: key });
  };
  add('pack', args.packGenerated);
  add('lesson', args.lessonGenerated);
  add('voice', args.voiceGenerated);
  add('card', args.cardGenerated);
  add('picture', args.imageGenerated);
  return out;
}

function reusedScopes(t: SessionTelemetry, scope: Scope): WorkClaim[] {
  const out: WorkClaim[] = [];
  const add = (kind: ReuseKind, uses: number, savedUsd: number) => {
    const key = uses > 0 ? scopeKeyFor(kind, scope) : null;
    if (key) out.push({ kind, scopeKey: key, uses, savedUsd: round(savedUsd) });
  };
  const savedFrom = (match: (s: StageSample) => boolean) =>
    t.stages.filter((s) => match(s) && reusedSample(s)).reduce((n, s) => n + savedOf(s), 0);

  add(
    'pack',
    t.reuse.packHit ? 1 : 0,
    savedFrom((s) => s.stage === 'resolve'),
  );
  add(
    'lesson',
    t.reuse.memoSegmentsReused,
    // The plan arrives with the memo, so its saving belongs to the same reuse.
    savedFrom((s) => s.stage === 'llm' && (purposeOf(s) === 'lesson' || purposeOf(s) === 'plan')),
  );
  add(
    'voice',
    t.reuse.ttsSentencesReused,
    savedFrom((s) => s.stage === 'tts'),
  );
  add(
    'card',
    t.stages.some((s) => s.stage === 'llm' && purposeOf(s) === CARD_PURPOSE && reusedSample(s))
      ? 1
      : 0,
    savedFrom((s) => s.stage === 'llm' && purposeOf(s) === CARD_PURPOSE),
  );
  add(
    'picture',
    t.stages.some(
      (s) => s.stage === 'image' && purposeOf(s) === THUMBNAIL_PURPOSE && reusedSample(s),
    )
      ? 1
      : 0,
    savedFrom((s) => s.stage === 'image' && purposeOf(s) === THUMBNAIL_PURPOSE),
  );
  return out;
}
