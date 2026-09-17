import type {
  CostByComponent,
  CostComponent,
  CostLine,
  ErrorEvent,
  InteractionEvent,
  LedgerEntry,
  Percentiles,
  ReuseSummary,
  SessionTelemetry,
  StageSample,
} from '@pen/contracts';

/**
 * Computes a session's telemetry summary from its recording ledger (ADR-0011).
 * Pure: the same ledger always yields the same numbers, so the Insights tab,
 * the PostHog `session_ended` event, `/api/stats/reuse` and the pull-back
 * script agree. Identity (plan, expert, language, canonical topic) is read
 * from the ledger itself when the caller does not know it.
 */
export interface TelemetryInput {
  sessionId: string;
  plan?: string;
  expertId?: string;
  language?: string;
  entries: LedgerEntry[];
}

/** Nearest-rank percentile on a copy; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export function percentiles(values: number[]): Percentiles {
  return { p50: percentile(values, 50), p95: percentile(values, 95), n: values.length };
}

function numberMeta(sample: StageSample, key: string): number | null {
  const v = sample.meta[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function stringMeta(sample: StageSample, key: string): string | null {
  const v = sample.meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numberProp(interaction: InteractionEvent, key: string): number | null {
  const v = interaction.props[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function summariseCosts(lines: CostLine[]): {
  totalUsd: number;
  revenueUsd: number;
  byComponent: Partial<Record<CostComponent, CostByComponent>>;
} {
  const byComponent: Partial<Record<CostComponent, CostByComponent>> = {};
  let totalUsd = 0;
  let revenueUsd = 0;
  for (const line of lines) {
    const entry = byComponent[line.component] ?? { usd: 0, calls: 0, units: {} };
    entry.usd += line.usd;
    // Three token lines describe one model call; every other component is one line per call.
    if (line.component !== 'llm' || line.unit === 'tokens_in') entry.calls += 1;
    entry.units[line.unit] = (entry.units[line.unit] ?? 0) + line.units;
    byComponent[line.component] = entry;
    // The ad credit is revenue, not spend: it sits beside the total, never inside it.
    if (line.component === 'ads') revenueUsd += line.usd;
    else totalUsd += line.usd;
  }
  return { totalUsd, revenueUsd, byComponent };
}

/** What this session served from earlier work, read off the stage samples' `reused` / `savedUsd` meta. */
export function summariseReuse(stages: StageSample[], totalUsd: number): ReuseSummary {
  const reused = (s: StageSample) => s.meta.reused === true;
  const resolve = stages.find((s) => s.stage === 'resolve' && s.meta.timing !== true);
  const intake = stages.find((s) => s.stage === 'intake');
  const lessons = stages.filter((s) => s.stage === 'llm' && s.meta.purpose === 'lesson');
  const savedUsd = stages.reduce(
    (n, s) => n + (reused(s) ? (numberMeta(s, 'savedUsd') ?? 0) : 0),
    0,
  );
  return {
    packHit: resolve ? reused(resolve) : false,
    memoSegmentsReused: lessons.filter(reused).length,
    memoSegmentsGenerated: lessons.filter((s) => !reused(s) && s.ok).length,
    contextSpeculationHits: stages.filter((s) => s.stage === 'context' && reused(s)).length,
    intakeCacheHit: intake ? reused(intake) : false,
    savedUsd,
    freshEquivalentUsd: totalUsd + savedUsd,
  };
}

export function computeTelemetry(input: TelemetryInput): SessionTelemetry {
  const stages: StageSample[] = [];
  const lines: CostLine[] = [];
  const interactions: InteractionEvent[] = [];
  const errors: ErrorEvent[] = [];
  const participants = new Set<string>();
  const segments = new Set<number>();
  let says = 0;
  let questions = 0;
  let interrupts = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const e of input.entries) {
    first = Math.min(first, e.t);
    last = Math.max(last, e.t);
    switch (e.kind) {
      case 'metric':
        stages.push(e.sample);
        break;
      case 'cost':
        lines.push(e.line);
        break;
      case 'interaction':
        interactions.push(e.interaction);
        break;
      case 'error':
        errors.push(e.error);
        break;
      case 'join':
        participants.add(e.participantId);
        break;
      case 'interrupt':
        interrupts += 1;
        break;
      case 'cue':
        if (e.cue.thread === 'lesson') segments.add(e.cue.segment);
        if (e.cue.event.type === 'say') says += 1;
        if (e.cue.event.type === 'note') questions += 1;
        break;
      default:
        break;
    }
  }
  stages.sort((a, b) => a.t - b.t);
  interactions.sort((a, b) => a.t - b.t);
  errors.sort((a, b) => a.t - b.t);
  const durationMs = Number.isFinite(first) ? Math.max(0, last - first) : 0;

  // Identity: what the caller knows, else what the host's join sample and the resolution recorded.
  const hostJoin = stages.find((s) => s.stage === 'join' && s.meta.role === 'host');
  const resolve = stages.find(
    (s) => s.stage === 'resolve' && stringMeta(s, 'canonicalId') !== null,
  );
  const plan = input.plan ?? (hostJoin ? stringMeta(hostJoin, 'plan') : null) ?? 'unknown';
  const expertId =
    input.expertId ?? (hostJoin ? stringMeta(hostJoin, 'expertId') : null) ?? 'unknown-expert';
  const language = input.language ?? (hostJoin ? stringMeta(hostJoin, 'language') : null) ?? 'und';
  const canonicalId = resolve ? stringMeta(resolve, 'canonicalId') : null;

  const turns = stages.filter((s) => s.stage === 'turn' && s.ok).map((s) => s.ms);
  const llmFirst = stages
    .filter((s) => s.stage === 'llm' && s.ok)
    .flatMap((s) => {
      const v = numberMeta(s, 'firstTokenMs');
      return v === null ? [] : [v];
    });
  const ttsFirst = stages
    .filter((s) => s.stage === 'tts' && s.ok)
    .flatMap((s) => {
      const v = numberMeta(s, 'firstChunkMs');
      return v === null ? [] : [v];
    });
  const sttFinal = stages.filter((s) => s.stage === 'stt' && s.ok).map((s) => s.ms);
  const bargeIn = interactions
    .filter((i) => i.event === 'interrupt')
    .flatMap((i) => {
      const v = numberProp(i, 'latency.bargeInMs');
      return v === null ? [] : [v];
    });

  // Time to first audio: what the host's client heard; failing that, when the server sent the first chunk.
  const reported = interactions.find((i) => i.event === 'first_audio');
  const reportedMs = reported ? numberProp(reported, 'latency.fromStartMs') : null;
  const firstTts = stages.find(
    (s) => s.stage === 'tts' && s.ok && numberMeta(s, 'firstChunkMs') !== null,
  );
  const serverMs = firstTts ? firstTts.t + (numberMeta(firstTts, 'firstChunkMs') ?? 0) : null;
  const timeToFirstAudioMs = reportedMs ?? serverMs;

  const adsShown = interactions.filter((i) => i.event === 'ad_shown').length;
  const adsSkipped = interactions.filter((i) => i.event === 'ad_skipped').length;
  const cost = summariseCosts(lines);

  return {
    sessionId: input.sessionId,
    plan,
    expertId,
    language,
    canonicalId,
    totals: {
      durationMs,
      segments: segments.size,
      says,
      questions,
      interrupts,
      adsShown,
      adsSkipped,
      participants: participants.size,
    },
    latency: {
      timeToFirstAudioMs,
      questionToFirstAudioMs: percentiles(turns),
      llmFirstTokenMs: percentiles(llmFirst),
      ttsFirstChunkMs: percentiles(ttsFirst),
      sttFinalMs: percentiles(sttFinal),
      bargeInMs: percentiles(bargeIn),
    },
    cost: {
      totalUsd: cost.totalUsd,
      revenueUsd: cost.revenueUsd,
      byComponent: cost.byComponent,
      lines,
    },
    reuse: summariseReuse(stages, cost.totalUsd),
    stages,
    interactions,
    errors,
  };
}

// ── aggregates across sessions (same-intent reuse) ───────────────────────────
export interface TopicReuseStats {
  canonicalId: string;
  sessions: number;
  /** Sessions that resolved to an existing pack instead of preparing one. */
  packHits: number;
  packHitRate: number;
  memoSegmentsReused: number;
  memoSegmentsGenerated: number;
  /** reused / (reused + generated); 0 when nothing was taught. */
  memoReuseRate: number;
  intakeCacheHits: number;
  contextSpeculationHits: number;
  avgCostUsd: number;
  avgFreshEquivalentUsd: number;
  totalCostUsd: number;
  totalSavedUsd: number;
}

export interface ReuseStats {
  topics: TopicReuseStats[];
  totals: Omit<TopicReuseStats, 'canonicalId'> & { topics: number };
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function finish(
  acc: Omit<
    TopicReuseStats,
    'canonicalId' | 'packHitRate' | 'memoReuseRate' | 'avgCostUsd' | 'avgFreshEquivalentUsd'
  >,
) {
  return {
    ...acc,
    packHitRate: rate(acc.packHits, acc.sessions),
    memoReuseRate: rate(acc.memoSegmentsReused, acc.memoSegmentsReused + acc.memoSegmentsGenerated),
    avgCostUsd: rate(acc.totalCostUsd, acc.sessions),
    avgFreshEquivalentUsd: rate(acc.totalCostUsd + acc.totalSavedUsd, acc.sessions),
  };
}

/** Per canonical topic (sessions without one are grouped under "unresolved") and overall. */
export function aggregateReuse(
  sessions: Array<Pick<SessionTelemetry, 'canonicalId' | 'cost' | 'reuse'>>,
): ReuseStats {
  const empty = () => ({
    sessions: 0,
    packHits: 0,
    memoSegmentsReused: 0,
    memoSegmentsGenerated: 0,
    intakeCacheHits: 0,
    contextSpeculationHits: 0,
    totalCostUsd: 0,
    totalSavedUsd: 0,
  });
  const byTopic = new Map<string, ReturnType<typeof empty>>();
  const all = empty();
  const add = (acc: ReturnType<typeof empty>, s: (typeof sessions)[number]) => {
    acc.sessions += 1;
    acc.packHits += s.reuse.packHit ? 1 : 0;
    acc.memoSegmentsReused += s.reuse.memoSegmentsReused;
    acc.memoSegmentsGenerated += s.reuse.memoSegmentsGenerated;
    acc.intakeCacheHits += s.reuse.intakeCacheHit ? 1 : 0;
    acc.contextSpeculationHits += s.reuse.contextSpeculationHits;
    acc.totalCostUsd += s.cost.totalUsd;
    acc.totalSavedUsd += s.reuse.savedUsd;
  };
  for (const s of sessions) {
    const key = s.canonicalId ?? 'unresolved';
    const acc = byTopic.get(key) ?? empty();
    add(acc, s);
    byTopic.set(key, acc);
    add(all, s);
  }
  const topics = [...byTopic.entries()]
    .map(([canonicalId, acc]) => ({ canonicalId, ...finish(acc) }))
    .sort((a, b) => b.sessions - a.sessions || a.canonicalId.localeCompare(b.canonicalId));
  return { topics, totals: { ...finish(all), topics: byTopic.size } };
}

// ── PostHog property shapes ──────────────────────────────────────────────────
/**
 * The `session_ended` PostHog properties: numbers, booleans and codes only,
 * flat and dotted (`cost.totalUsd`, `reuse.savedUsd`, `latency.…`) so HogQL
 * and the PostHog UI can filter, group and chart them directly.
 */
export function sessionEndedProperties(
  t: SessionTelemetry,
  extra: { completed: boolean; providers: { llm: string; tts: string; stt: string } },
): Record<string, string | number | boolean | null> {
  const units = (c: CostComponent, u: keyof CostByComponent['units']) =>
    t.cost.byComponent[c]?.units[u] ?? 0;
  const usd = (c: CostComponent) => round6(t.cost.byComponent[c]?.usd ?? 0);
  return {
    sessionId: t.sessionId,
    canonicalId: t.canonicalId,
    plan: t.plan,
    expertId: t.expertId,
    language: t.language,
    completed: extra.completed,
    'provider.llm': extra.providers.llm,
    'provider.tts': extra.providers.tts,
    'provider.stt': extra.providers.stt,
    durationMs: t.totals.durationMs,
    segments: t.totals.segments,
    says: t.totals.says,
    questions: t.totals.questions,
    interrupts: t.totals.interrupts,
    adsShown: t.totals.adsShown,
    adsSkipped: t.totals.adsSkipped,
    participants: t.totals.participants,
    errors: t.errors.length,
    stages: t.stages.length,
    interactions: t.interactions.length,
    'latency.timeToFirstAudioMs': t.latency.timeToFirstAudioMs,
    'latency.questionToFirstAudioP50': t.latency.questionToFirstAudioMs.p50,
    'latency.questionToFirstAudioP95': t.latency.questionToFirstAudioMs.p95,
    'latency.llmFirstTokenP50': t.latency.llmFirstTokenMs.p50,
    'latency.llmFirstTokenP95': t.latency.llmFirstTokenMs.p95,
    'latency.ttsFirstChunkP50': t.latency.ttsFirstChunkMs.p50,
    'latency.ttsFirstChunkP95': t.latency.ttsFirstChunkMs.p95,
    'latency.sttFinalP50': t.latency.sttFinalMs.p50,
    'latency.sttFinalP95': t.latency.sttFinalMs.p95,
    'latency.bargeInP50': t.latency.bargeInMs.p50,
    'latency.bargeInP95': t.latency.bargeInMs.p95,
    'cost.totalUsd': round6(t.cost.totalUsd),
    'cost.llmUsd': usd('llm'),
    'cost.ttsUsd': usd('tts'),
    'cost.sttUsd': usd('stt'),
    'cost.searchUsd': usd('search'),
    'cost.adsRevenueUsd': round6(t.cost.revenueUsd),
    'cost.adsCompleted': t.cost.byComponent.ads?.calls ?? 0,
    'cost.llmCalls': t.cost.byComponent.llm?.calls ?? 0,
    'cost.tokensIn': units('llm', 'tokens_in'),
    'cost.tokensCached': units('llm', 'tokens_cached'),
    'cost.tokensOut': units('llm', 'tokens_out'),
    'cost.ttsBytes': units('tts', 'bytes'),
    'cost.sttSeconds': round6(units('stt', 'seconds')),
    'cost.searchRequests': units('search', 'requests'),
    'reuse.packHit': t.reuse.packHit,
    'reuse.memoSegmentsReused': t.reuse.memoSegmentsReused,
    'reuse.memoSegmentsGenerated': t.reuse.memoSegmentsGenerated,
    'reuse.contextSpeculationHits': t.reuse.contextSpeculationHits,
    'reuse.intakeCacheHit': t.reuse.intakeCacheHit,
    'reuse.savedUsd': round6(t.reuse.savedUsd),
    'reuse.freshEquivalentUsd': round6(t.reuse.freshEquivalentUsd),
  };
}

/** A `stage` PostHog event's properties: the sample flattened, meta prefixed so keys never collide. */
export function stageProperties(
  sessionId: string,
  sample: StageSample,
): Record<string, string | number | boolean | null> {
  const props: Record<string, string | number | boolean | null> = {
    sessionId,
    stage: sample.stage,
    t: sample.t,
    ms: sample.ms,
    ok: sample.ok,
  };
  for (const [k, v] of Object.entries(sample.meta)) props[`meta.${k}`] = v;
  return props;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
