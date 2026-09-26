import { type SQL, sql } from 'drizzle-orm';
import type { Database } from './client.js';

/**
 * Reading the statistics (ADR-0027). Every answer here is one SQL statement
 * against the derived tables — no ledger is opened, no file is read, and
 * nothing is computed per row in JavaScript. That is the whole point of
 * deriving: "the average across every session" has to be a query.
 *
 * Windows are `[from, to)` in ms epoch and buckets are UTC, except where a
 * report says otherwise (`usageClock` reads the visitor's own clock, which is
 * the only honest way to ask "when do people learn").
 *
 * Opt-out: `participants.analytics_opt_out` stops visits being *written* at
 * all, so no read here needs to filter them. `session_stats.host_opted_out`
 * exists for the one thing that is still written — the session's own cost —
 * and every per-person report below excludes it.
 */

export type Bucket = 'hour' | 'day' | 'week' | 'month';

/** `execute()` yields `{ rows }` on PGlite and a bare array on postgres-js. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const boxed = result as { rows?: unknown };
  return Array.isArray(boxed.rows) ? (boxed.rows as T[]) : [];
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
};
const nn = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const b = (v: unknown): boolean => v === true || v === 't' || v === 1 || v === '1';

/** A millisecond column truncated to a UTC bucket and handed back as ms epoch. */
function bucketMs(column: SQL, bucket: Bucket): SQL {
  return sql`(extract(epoch from date_trunc(${bucket}, to_timestamp(${column} / 1000.0) at time zone 'UTC')) * 1000)::bigint`;
}

export interface Window {
  from: number;
  to: number;
}

const DAY_MS = 86_400_000;

export class ReportRepository {
  constructor(private readonly db: Database) {}

  // ── the headline ───────────────────────────────────────────────────────────
  /** What a dashboard opens on: one row of numbers for a window, and the same window before it. */
  async overview(w: Window): Promise<OverviewReport> {
    const rows = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select
          count(*)::int                                        as sessions,
          count(*) filter (where completed)::int               as completed,
          count(distinct host_id)::int                         as learners,
          coalesce(sum(total_usd), 0)                          as total_usd,
          coalesce(sum(revenue_usd), 0)                        as revenue_usd,
          coalesce(sum(saved_usd), 0)                          as saved_usd,
          coalesce(sum(fresh_equivalent_usd), 0)               as fresh_equivalent_usd,
          coalesce(sum(duration_ms), 0)::bigint                as duration_ms,
          coalesce(avg(nullif(duration_ms, 0)), 0)             as avg_duration_ms,
          coalesce(avg(progress), 0)                           as avg_progress,
          count(*) filter (where pack_hit)::int                as pack_hits,
          coalesce(sum(errors), 0)::int                        as errors,
          percentile_disc(0.5) within group (order by time_to_first_audio_ms)
            filter (where time_to_first_audio_ms is not null)  as tta_p50,
          percentile_disc(0.95) within group (order by time_to_first_audio_ms)
            filter (where time_to_first_audio_ms is not null)  as tta_p95
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
      `),
    );
    const r = rows[0] ?? {};
    const visits = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select
          count(*)::int                                     as visits,
          count(distinct coalesce(participant_id, id))::int as visitors,
          coalesce(sum(active_ms), 0)::bigint               as active_ms,
          count(*) filter (where sessions_started > 0)::int as converting
        from site_visits
        where started_at >= ${w.from} and started_at < ${w.to}
      `),
    );
    const v = visits[0] ?? {};
    const sessions = n(r.sessions);
    const visitCount = n(v.visits);
    return {
      window: w,
      sessions,
      completed: n(r.completed),
      completionRate: sessions > 0 ? n(r.completed) / sessions : 0,
      learners: n(r.learners),
      totalUsd: n(r.total_usd),
      revenueUsd: n(r.revenue_usd),
      savedUsd: n(r.saved_usd),
      freshEquivalentUsd: n(r.fresh_equivalent_usd),
      costPerSessionUsd: sessions > 0 ? n(r.total_usd) / sessions : 0,
      reuseRate: n(r.fresh_equivalent_usd) > 0 ? n(r.saved_usd) / n(r.fresh_equivalent_usd) : 0,
      packHitRate: sessions > 0 ? n(r.pack_hits) / sessions : 0,
      durationMs: n(r.duration_ms),
      avgDurationMs: n(r.avg_duration_ms),
      avgProgress: n(r.avg_progress),
      errors: n(r.errors),
      timeToFirstAudioP50Ms: nn(r.tta_p50),
      timeToFirstAudioP95Ms: nn(r.tta_p95),
      visits: visitCount,
      visitors: n(v.visitors),
      activeMs: n(v.active_ms),
      visitToSession: visitCount > 0 ? n(v.converting) / visitCount : 0,
    };
  }

  // ── cost ───────────────────────────────────────────────────────────────────
  async costSeries(w: Window, bucket: Bucket): Promise<CostPointRow[]> {
    const at = bucketMs(sql`started_at`, bucket);
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select ${at} as at,
          count(*)::int as sessions,
          coalesce(sum(total_usd), 0)            as total_usd,
          coalesce(sum(llm_usd), 0)              as llm_usd,
          coalesce(sum(intent_usd), 0)           as intent_usd,
          coalesce(sum(image_usd), 0)            as image_usd,
          coalesce(sum(tts_usd), 0)              as tts_usd,
          coalesce(sum(stt_usd), 0)              as stt_usd,
          coalesce(sum(search_usd), 0)           as search_usd,
          coalesce(sum(revenue_usd), 0)          as revenue_usd,
          coalesce(sum(fresh_equivalent_usd), 0) as fresh_equivalent_usd,
          coalesce(sum(saved_usd), 0)            as saved_usd
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1 order by 1
      `),
    ).map((r) => ({
      at: n(r.at),
      sessions: n(r.sessions),
      totalUsd: n(r.total_usd),
      llmUsd: n(r.llm_usd),
      intentUsd: n(r.intent_usd),
      imageUsd: n(r.image_usd),
      ttsUsd: n(r.tts_usd),
      sttUsd: n(r.stt_usd),
      searchUsd: n(r.search_usd),
      revenueUsd: n(r.revenue_usd),
      freshEquivalentUsd: n(r.fresh_equivalent_usd),
      savedUsd: n(r.saved_usd),
    }));
  }

  /** Cost split by the host's plan at the time, and by expert. */
  async costByPlan(
    w: Window,
  ): Promise<
    Array<{ plan: string; sessions: number; totalUsd: number; costPerSessionUsd: number }>
  > {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select plan, count(*)::int as sessions, coalesce(sum(total_usd), 0) as total_usd
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1 order by 3 desc
      `),
    ).map((r) => ({
      plan: s(r.plan) ?? 'unknown',
      sessions: n(r.sessions),
      totalUsd: n(r.total_usd),
      costPerSessionUsd: n(r.sessions) > 0 ? n(r.total_usd) / n(r.sessions) : 0,
    }));
  }

  /** Cost and first-chunk latency per voice engine (ADR-0048); `unknown` is a session from before engines were a choice. */
  async costByVoiceEngine(w: Window): Promise<
    Array<{
      engine: string;
      sessions: number;
      totalUsd: number;
      ttsUsd: number;
      costPerSessionUsd: number;
      ttsFirstChunkP50Ms: number | null;
    }>
  > {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select coalesce(voice_engine, 'unknown') as engine,
               count(*)::int as sessions,
               coalesce(sum(total_usd), 0) as total_usd,
               coalesce(sum(tts_usd), 0) as tts_usd,
               percentile_cont(0.5) within group (order by tts_first_chunk_p50_ms) as p50
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1 order by 2 desc
      `),
    ).map((r) => ({
      engine: s(r.engine) ?? 'unknown',
      sessions: n(r.sessions),
      totalUsd: n(r.total_usd),
      ttsUsd: n(r.tts_usd),
      costPerSessionUsd: n(r.sessions) > 0 ? n(r.total_usd) / n(r.sessions) : 0,
      ttsFirstChunkP50Ms: nn(r.p50),
    }));
  }

  async costByExpert(
    w: Window,
    limit = 20,
  ): Promise<Array<{ expertId: string; sessions: number; totalUsd: number }>> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select expert_id, count(*)::int as sessions, coalesce(sum(total_usd), 0) as total_usd
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1 order by 3 desc limit ${limit}
      `),
    ).map((r) => ({
      expertId: s(r.expert_id) ?? 'unknown',
      sessions: n(r.sessions),
      totalUsd: n(r.total_usd),
    }));
  }

  /** Per stage, across every session in the window: the observability the owner asked for. */
  async stageSummary(w: Window): Promise<StageSummaryRow[]> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select g.stage,
          count(distinct g.session_id)::int as sessions,
          coalesce(sum(g.samples), 0)::int  as samples,
          coalesce(sum(g.failed), 0)::int   as failed,
          coalesce(sum(g.reused), 0)::int   as reused,
          coalesce(sum(g.usd), 0)           as usd,
          coalesce(sum(g.saved_usd), 0)     as saved_usd,
          percentile_disc(0.5)  within group (order by g.p50_ms) as p50_ms,
          percentile_disc(0.95) within group (order by g.p95_ms) as p95_ms,
          max(g.max_ms)                                          as max_ms
        from session_stage_stats g
        join session_stats t on t.session_id = g.session_id
        where t.started_at >= ${w.from} and t.started_at < ${w.to}
        group by 1 order by 6 desc, 3 desc
      `),
    ).map((r) => ({
      stage: s(r.stage) ?? 'unknown',
      sessions: n(r.sessions),
      samples: n(r.samples),
      failed: n(r.failed),
      reused: n(r.reused),
      usd: n(r.usd),
      savedUsd: n(r.saved_usd),
      p50Ms: nn(r.p50_ms),
      p95Ms: nn(r.p95_ms),
      maxMs: nn(r.max_ms),
    }));
  }

  /** Error codes across the window: which, how often, in how many sessions. */
  async errorSummary(
    w: Window,
    limit = 50,
  ): Promise<Array<{ code: string; stage: string | null; n: number; sessions: number }>> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select e.code, min(e.stage) as stage,
          coalesce(sum(e.n), 0)::int as n,
          count(distinct e.session_id)::int as sessions
        from session_error_stats e
        join session_stats t on t.session_id = e.session_id
        where t.started_at >= ${w.from} and t.started_at < ${w.to}
        group by 1 order by 3 desc limit ${limit}
      `),
    ).map((r) => ({
      code: s(r.code) ?? 'unknown',
      stage: s(r.stage),
      n: n(r.n),
      sessions: n(r.sessions),
    }));
  }

  // ── why people stop ────────────────────────────────────────────────────────
  /** Where sessions end, and how far in. The owner's "why did they stop in the middle". */
  async abandonment(w: Window): Promise<AbandonmentReport> {
    const reasons = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select leave_reason,
          count(*)::int                        as sessions,
          coalesce(avg(progress), 0)           as avg_progress,
          coalesce(avg(duration_ms), 0)        as avg_duration_ms,
          coalesce(avg(segments_reached), 0)   as avg_segment
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1 order by 2 desc
      `),
    ).map((r) => ({
      reason: s(r.leave_reason) ?? 'unknown',
      sessions: n(r.sessions),
      avgProgress: n(r.avg_progress),
      avgDurationMs: n(r.avg_duration_ms),
      avgSegmentReached: n(r.avg_segment),
    }));
    // Where in the lesson they were when they stopped: a drop-off curve.
    const bySegment = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select segments_reached as segment, count(*)::int as sessions
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to} and not completed
        group by 1 order by 1
      `),
    ).map((r) => ({ segment: n(r.segment), sessions: n(r.sessions) }));
    const lastSeen = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select coalesce(last_interaction, '(none)') as last_interaction,
               coalesce(last_stage, '(none)')       as last_stage,
               count(*)::int                        as sessions
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to} and not completed
        group by 1, 2 order by 3 desc limit 30
      `),
    ).map((r) => ({
      lastInteraction: s(r.last_interaction) ?? '(none)',
      lastStage: s(r.last_stage) ?? '(none)',
      sessions: n(r.sessions),
    }));
    return { window: w, reasons, bySegment, lastSeen };
  }

  // ── reuse ──────────────────────────────────────────────────────────────────
  async reuseTotals(w: Window): Promise<ReuseTotals> {
    const t =
      rowsOf<Record<string, unknown>>(
        await this.db.execute(sql`
        select
          count(*)::int                                 as sessions,
          count(*) filter (where pack_hit)::int         as pack_hits,
          count(*) filter (where image_reused)::int     as picture_reuses,
          count(*) filter (where card_reused)::int      as card_reuses,
          coalesce(sum(memo_segments_reused), 0)::int   as memo_reused,
          coalesce(sum(memo_segments_generated), 0)::int as memo_generated,
          coalesce(sum(tts_sentences_reused), 0)::int   as tts_reused,
          coalesce(sum(tts_sentences_generated), 0)::int as tts_generated,
          coalesce(sum(context_speculation_hits), 0)::int as speculation_hits,
          coalesce(sum(saved_usd), 0)                   as saved_usd,
          coalesce(sum(total_usd), 0)                   as total_usd,
          coalesce(sum(fresh_equivalent_usd), 0)        as fresh_usd
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
      `),
      )[0] ?? {};
    const byKind = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select kind, count(*)::int as links, coalesce(sum(uses), 0)::int as uses,
               coalesce(sum(saved_usd), 0) as saved_usd
        from session_reuse_links
        where at >= ${w.from} and at < ${w.to}
        group by 1 order by 4 desc
      `),
    ).map((r) => ({
      kind: s(r.kind) ?? 'unknown',
      links: n(r.links),
      uses: n(r.uses),
      savedUsd: n(r.saved_usd),
    }));
    return {
      window: w,
      sessions: n(t.sessions),
      packHits: n(t.pack_hits),
      pictureReuses: n(t.picture_reuses),
      cardReuses: n(t.card_reuses),
      memoSegmentsReused: n(t.memo_reused),
      memoSegmentsGenerated: n(t.memo_generated),
      ttsSentencesReused: n(t.tts_reused),
      ttsSentencesGenerated: n(t.tts_generated),
      contextSpeculationHits: n(t.speculation_hits),
      savedUsd: n(t.saved_usd),
      totalUsd: n(t.total_usd),
      freshEquivalentUsd: n(t.fresh_usd),
      savedShare: n(t.fresh_usd) > 0 ? n(t.saved_usd) / n(t.fresh_usd) : 0,
      byKind,
    };
  }

  /** The sessions other sessions lean on hardest. */
  async mostReusedSessions(
    w: Window,
    limit = 25,
  ): Promise<
    Array<{
      sessionId: string;
      topic: string;
      reusedBy: number;
      uses: number;
      savedForOthersUsd: number;
    }>
  > {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select l.source_session_id as session_id,
               coalesce(max(o.topic), '')        as topic,
               count(distinct l.session_id)::int as reused_by,
               coalesce(sum(l.uses), 0)::int     as uses,
               coalesce(sum(l.saved_usd), 0)     as saved_usd
        from session_reuse_links l
        left join stats_work_origin o on o.session_id = l.source_session_id
        where l.source_session_id is not null and l.at >= ${w.from} and l.at < ${w.to}
        group by 1 order by 3 desc, 5 desc limit ${limit}
      `),
    ).map((r) => ({
      sessionId: s(r.session_id) ?? '',
      topic: s(r.topic) ?? '',
      reusedBy: n(r.reused_by),
      uses: n(r.uses),
      savedForOthersUsd: n(r.saved_usd),
    }));
  }

  /**
   * One session's reuse, answered the way the owner asked it: how many times,
   * and for which searches. The searches are the topics later learners typed.
   */
  async sessionReuse(sessionId: string): Promise<{
    reusedBy: number;
    uses: number;
    savedForOthersUsd: number;
    byKind: Array<{ kind: string; uses: number; savedUsd: number }>;
    searches: Array<{ topic: string; uses: number; lastAt: number }>;
  }> {
    const totals =
      rowsOf<Record<string, unknown>>(
        await this.db.execute(sql`
        select count(distinct session_id)::int as reused_by,
               coalesce(sum(uses), 0)::int     as uses,
               coalesce(sum(saved_usd), 0)     as saved_usd
        from session_reuse_links where source_session_id = ${sessionId}
      `),
      )[0] ?? {};
    const byKind = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select kind, coalesce(sum(uses), 0)::int as uses, coalesce(sum(saved_usd), 0) as saved_usd
        from session_reuse_links where source_session_id = ${sessionId}
        group by 1 order by 2 desc
      `),
    ).map((r) => ({ kind: s(r.kind) ?? '', uses: n(r.uses), savedUsd: n(r.saved_usd) }));
    const searches = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select topic, count(distinct session_id)::int as uses, max(at) as last_at
        from session_reuse_links
        where source_session_id = ${sessionId} and topic <> ''
        group by 1 order by 2 desc, 3 desc limit 100
      `),
    ).map((r) => ({ topic: s(r.topic) ?? '', uses: n(r.uses), lastAt: n(r.last_at) }));
    return {
      reusedBy: n(totals.reused_by),
      uses: n(totals.uses),
      savedForOthersUsd: n(totals.saved_usd),
      byKind,
      searches,
    };
  }

  // ── sessions and people ────────────────────────────────────────────────────
  async sessions(q: SessionQuery): Promise<{ rows: SessionListRow[]; total: number }> {
    const conditions: SQL[] = [
      sql`t.started_at >= ${q.window.from}`,
      sql`t.started_at < ${q.window.to}`,
    ];
    if (q.plan) conditions.push(sql`t.plan = ${q.plan}`);
    if (q.leaveReason) conditions.push(sql`t.leave_reason = ${q.leaveReason}`);
    if (q.hostId) conditions.push(sql`t.host_id = ${q.hostId}`);
    if (q.expertId) conditions.push(sql`t.expert_id = ${q.expertId}`);
    if (q.voiceEngine) conditions.push(sql`t.voice_engine = ${q.voiceEngine}`);
    if (q.completed !== undefined) conditions.push(sql`t.completed = ${q.completed}`);
    const where = sql.join(conditions, sql` and `);
    // Unknown — or `constructor` — falls back rather than reaching SQL.
    const order = ORDERABLE.get(q.orderBy ?? '') ?? (ORDERABLE.get('startedAt') as SQL);
    const direction = q.direction === 'asc' ? sql`asc` : sql`desc`;

    const total = n(
      rowsOf<Record<string, unknown>>(
        await this.db.execute(sql`select count(*)::int as n from session_stats t where ${where}`),
      )[0]?.n,
    );
    const rows = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select t.*, s.topic, s.title, s.views,
               coalesce(e.replays, 0)  as replays,
               coalesce(e.shares, 0)   as shares,
               coalesce(r.reused_by, 0) as reused_by
        from session_stats t
        left join sessions s on s.id = t.session_id
        left join session_engagement e on e.session_id = t.session_id
        left join (
          select source_session_id, count(distinct session_id)::int as reused_by
          from session_reuse_links where source_session_id is not null group by 1
        ) r on r.source_session_id = t.session_id
        where ${where}
        order by ${order} ${direction} nulls last, t.session_id
        limit ${Math.min(q.limit ?? 50, 500)} offset ${Math.max(q.offset ?? 0, 0)}
      `),
    ).map(toSessionListRow);
    return { rows, total };
  }

  /** One session, everything derived about it. */
  async session(sessionId: string): Promise<SessionDetail | null> {
    const row = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select t.*, s.topic, s.title, s.views,
               coalesce(e.replays, 0) as replays, coalesce(e.shares, 0) as shares,
               coalesce(e.downloads, 0) as downloads, coalesce(e.exports, 0) as exports
        from session_stats t
        left join sessions s on s.id = t.session_id
        left join session_engagement e on e.session_id = t.session_id
        where t.session_id = ${sessionId}
      `),
    )[0];
    if (!row) return null;
    const stages = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select * from session_stage_stats where session_id = ${sessionId} order by first_at_ms
      `),
    ).map((r) => ({
      stage: s(r.stage) ?? '',
      samples: n(r.samples),
      ok: n(r.ok),
      failed: n(r.failed),
      reused: n(r.reused),
      totalMs: n(r.total_ms),
      p50Ms: nn(r.p50_ms),
      p95Ms: nn(r.p95_ms),
      maxMs: nn(r.max_ms),
      usd: n(r.usd),
      savedUsd: n(r.saved_usd),
      firstAtMs: n(r.first_at_ms),
      lastAtMs: n(r.last_at_ms),
    }));
    const errors = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select * from session_error_stats where session_id = ${sessionId} order by first_at_ms
      `),
    ).map((r) => ({
      code: s(r.code) ?? '',
      stage: s(r.stage),
      n: n(r.n),
      firstAtMs: n(r.first_at_ms),
      lastAtMs: n(r.last_at_ms),
    }));
    const tookFrom = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select kind, source_session_id, uses, saved_usd
        from session_reuse_links where session_id = ${sessionId} order by kind
      `),
    ).map((r) => ({
      kind: s(r.kind) ?? '',
      sourceSessionId: s(r.source_session_id),
      uses: n(r.uses),
      savedUsd: n(r.saved_usd),
    }));
    return {
      session: toSessionListRow(row),
      downloads: n(row.downloads),
      exports: n(row.exports),
      stages,
      errors,
      tookFrom,
      gaveTo: await this.sessionReuse(sessionId),
    };
  }

  /**
   * Per-user detail. Sessions, spend, time on the site and what they did with
   * it. Participants who turned analytics off are still here — the account is
   * theirs and so are its sessions — but they have no visits, so their active
   * time is zero and their device and country are unknown.
   */
  async users(q: UserQuery): Promise<{ rows: UserRow[]; total: number }> {
    const total = n(
      rowsOf<Record<string, unknown>>(
        await this.db.execute(sql`select count(*)::int as n from participants`),
      )[0]?.n,
    );
    const rows = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select p.id, p.name, p.plan, p.plan_interval, p.anonymous, p.analytics_opt_out,
               (extract(epoch from p.created_at) * 1000)::bigint   as created_at,
               (extract(epoch from p.last_seen_at) * 1000)::bigint as last_seen_at,
               coalesce(t.sessions, 0)::int      as sessions,
               coalesce(t.completed, 0)::int     as completed,
               coalesce(t.total_usd, 0)          as total_usd,
               coalesce(t.duration_ms, 0)::bigint as session_ms,
               coalesce(v.visits, 0)::int        as visits,
               coalesce(v.active_ms, 0)::bigint  as active_ms,
               v.country, v.device_type
        from participants p
        left join (
          select host_id,
                 count(*)::int as sessions,
                 count(*) filter (where completed)::int as completed,
                 sum(total_usd) as total_usd,
                 sum(duration_ms) as duration_ms
          from session_stats
          where started_at >= ${q.window.from} and started_at < ${q.window.to}
          group by 1
        ) t on t.host_id = p.id
        left join (
          select participant_id,
                 count(*)::int as visits,
                 sum(active_ms) as active_ms,
                 (array_agg(country order by started_at desc) filter (where country is not null))[1] as country,
                 (array_agg(device_type order by started_at desc))[1] as device_type
          from site_visits
          where participant_id is not null
            and started_at >= ${q.window.from} and started_at < ${q.window.to}
          group by 1
        ) v on v.participant_id = p.id
        order by ${USER_ORDER.get(q.orderBy ?? '') ?? (USER_ORDER.get('sessions') as SQL)} desc nulls last, p.id
        limit ${Math.min(q.limit ?? 50, 500)} offset ${Math.max(q.offset ?? 0, 0)}
      `),
    ).map((r) => ({
      id: s(r.id) ?? '',
      name: s(r.name) ?? '',
      plan: s(r.plan) ?? 'free',
      planInterval: s(r.plan_interval),
      anonymous: b(r.anonymous),
      analyticsOptOut: b(r.analytics_opt_out),
      createdAt: n(r.created_at),
      lastSeenAt: n(r.last_seen_at),
      sessions: n(r.sessions),
      completed: n(r.completed),
      totalUsd: n(r.total_usd),
      sessionMs: n(r.session_ms),
      visits: n(r.visits),
      activeMs: n(r.active_ms),
      country: s(r.country),
      deviceType: s(r.device_type),
    }));
    return { rows, total };
  }

  // ── people (ADR-0060) ──────────────────────────────────────────────────────
  /**
   * Who is here, in one answer: accounts, visitors, who pays and for what,
   * who is active and who came back, what they cost and what they paid. The
   * window governs the flows (new accounts, visitors, activity, cost,
   * revenue); the stocks (accounts, paying, free) are counted as of now,
   * because a plan is a present-tense fact about a row.
   *
   * A visitor is `coalesce(participant_id, visit id)`: the participant when
   * the beacon carried a bearer, else the visit. An anonymous participant is
   * minted per browser and kept in its storage, so a device that comes back
   * is the same visitor and a new device is a new one (ADR-0027).
   */
  async peopleSummary(w: Window): Promise<PeopleSummary> {
    const [stock, flow, activity, learners, money] = await Promise.all([
      this.db.execute(sql`
        select count(*) filter (where not anonymous)::int                                       as accounts,
               count(*) filter (where not anonymous and created_at >= ${new Date(w.from).toISOString()}::timestamptz
                                  and created_at < ${new Date(w.to).toISOString()}::timestamptz)::int as new_accounts,
               count(*) filter (where plan <> 'free')::int                                        as paying,
               count(*) filter (where plan = 'standard')::int                                     as standard,
               count(*) filter (where plan = 'professional')::int                                 as professional,
               count(*) filter (where plan <> 'free' and plan_interval = 'month')::int             as monthly,
               count(*) filter (where plan <> 'free' and plan_interval = 'year')::int              as yearly,
               count(*) filter (where plan <> 'free' and plan_status = 'cancelling')::int          as cancelling,
               count(*) filter (where not anonymous and plan = 'free')::int                        as free_accounts,
               count(*) filter (where anonymous)::int                                             as anonymous
        from participants
      `),
      this.db.execute(sql`
        select count(distinct v)::int                                as visitors,
               count(distinct v) filter (where days >= 2)::int       as returning,
               coalesce(sum(active_ms), 0)::bigint                   as active_ms
        from (
          select coalesce(participant_id, id) as v,
                 count(distinct (started_at / 86400000)) as days,
                 sum(active_ms) as active_ms
          from site_visits
          where started_at >= ${w.from} and started_at < ${w.to}
          group by 1
        ) x
      `),
      this.db.execute(sql`
        select count(distinct coalesce(participant_id, id)) filter (where last_seen_at >= ${w.to - DAY_MS})::int      as day,
               count(distinct coalesce(participant_id, id)) filter (where last_seen_at >= ${w.to - 7 * DAY_MS})::int  as week,
               count(distinct coalesce(participant_id, id)) filter (where last_seen_at >= ${w.to - 30 * DAY_MS})::int as month
        from site_visits
        where last_seen_at >= ${w.to - 30 * DAY_MS} and started_at < ${w.to}
      `),
      this.db.execute(sql`
        select count(distinct host_id)::int                    as learners,
               count(*)::int                                   as sessions,
               coalesce(sum(total_usd), 0)                     as total_usd,
               coalesce(avg(duration_ms), 0)::bigint           as avg_session_ms
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
      `),
      this.db.execute(sql`
        select coalesce(sum(amount_cents) filter (where to_plan <> 'free'), 0)::int as revenue_cents,
               count(*) filter (where to_plan <> 'free' and (from_plan is null or from_plan = 'free'))::int as subscribed,
               count(*) filter (where to_plan = 'free' and from_plan is not null and from_plan <> 'free')::int as churned
        from plan_events
        where at >= ${w.from} and at < ${w.to}
      `),
    ]);
    const st = rowsOf<Record<string, unknown>>(stock)[0] ?? {};
    const fl = rowsOf<Record<string, unknown>>(flow)[0] ?? {};
    const ac = rowsOf<Record<string, unknown>>(activity)[0] ?? {};
    const le = rowsOf<Record<string, unknown>>(learners)[0] ?? {};
    const mo = rowsOf<Record<string, unknown>>(money)[0] ?? {};
    const visitors = n(fl.visitors);
    const paying = n(st.paying);
    const totalUsd = n(le.total_usd);
    const learnerCount = n(le.learners);
    return {
      accounts: n(st.accounts),
      newAccounts: n(st.new_accounts),
      anonymous: n(st.anonymous),
      freeAccounts: n(st.free_accounts),
      paying,
      byPlan: { standard: n(st.standard), professional: n(st.professional) },
      byInterval: { month: n(st.monthly), year: n(st.yearly) },
      cancelling: n(st.cancelling),
      visitors,
      returning: n(fl.returning),
      active: { day: n(ac.day), week: n(ac.week), month: n(ac.month) },
      learners: learnerCount,
      sessions: n(le.sessions),
      avgActiveMsPerVisitor: visitors > 0 ? Math.round(n(fl.active_ms) / visitors) : 0,
      avgSessionMs: n(le.avg_session_ms),
      totalUsd,
      costPerLearnerUsd: learnerCount > 0 ? totalUsd / learnerCount : 0,
      costPerPayingUsd: paying > 0 ? totalUsd / paying : 0,
      revenueUsd: n(mo.revenue_cents) / 100,
      subscribed: n(mo.subscribed),
      churned: n(mo.churned),
    };
  }

  /** One participant's totals for the window: the same arithmetic as `users()`, for one row. */
  async userTotals(participantId: string, w: Window): Promise<UserTotals> {
    const r =
      rowsOf<Record<string, unknown>>(
        await this.db.execute(sql`
          select
            (select count(*)::int from session_stats
              where host_id = ${participantId} and started_at >= ${w.from} and started_at < ${w.to}) as sessions,
            (select count(*) filter (where completed)::int from session_stats
              where host_id = ${participantId} and started_at >= ${w.from} and started_at < ${w.to}) as completed,
            (select coalesce(sum(total_usd), 0) from session_stats
              where host_id = ${participantId} and started_at >= ${w.from} and started_at < ${w.to}) as total_usd,
            (select coalesce(sum(duration_ms), 0)::bigint from session_stats
              where host_id = ${participantId} and started_at >= ${w.from} and started_at < ${w.to}) as session_ms,
            (select count(*)::int from site_visits
              where participant_id = ${participantId} and started_at >= ${w.from} and started_at < ${w.to}) as visits,
            (select coalesce(sum(active_ms), 0)::bigint from site_visits
              where participant_id = ${participantId} and started_at >= ${w.from} and started_at < ${w.to}) as active_ms
        `),
      )[0] ?? {};
    return {
      sessions: n(r.sessions),
      completed: n(r.completed),
      totalUsd: n(r.total_usd),
      sessionMs: n(r.session_ms),
      visits: n(r.visits),
      activeMs: n(r.active_ms),
    };
  }

  /** One participant's subscription history, newest first. */
  async planEventsFor(participantId: string): Promise<PlanEventRow[]> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select at, from_plan, to_plan, interval, status, source, amount_cents, currency
        from plan_events where participant_id = ${participantId}
        order by at desc limit 100
      `),
    ).map((r) => ({
      at: n(r.at),
      fromPlan: s(r.from_plan),
      toPlan: s(r.to_plan) ?? 'free',
      interval: s(r.interval) as 'month' | 'year' | null,
      status: s(r.status),
      source: s(r.source),
      amountCents:
        r.amount_cents === null || r.amount_cents === undefined ? null : n(r.amount_cents),
      currency: s(r.currency),
    }));
  }

  // ── retention ──────────────────────────────────────────────────────────────
  /**
   * Cohorts by the bucket a participant was created in, against the buckets
   * they came back in. `session` counts hosting a session as coming back;
   * `visit` counts opening the site at all, which includes anyone who never
   * learned anything — the difference between the two is itself the report.
   *
   * Anonymous participants are counted: they are most of the product's
   * visitors, and leaving them out would make retention look like an
   * account-holder statistic. Their row is minted per browser, so a returning
   * anonymous learner on a new device is a new cohort member; the `visit`
   * metric therefore reads low on purpose, and the note is in
   * `docs/STATISTICS.md`.
   */
  async retention(w: Window, bucket: Bucket, metric: 'session' | 'visit'): Promise<RetentionRow[]> {
    const activity =
      metric === 'session'
        ? sql`select host_id as participant_id, started_at as at from session_stats`
        : sql`select participant_id, started_at as at from site_visits where participant_id is not null`;
    const cohortAt = bucketMs(sql`(extract(epoch from p.created_at) * 1000)::bigint`, bucket);
    const activeAt = bucketMs(sql`a.at`, bucket);
    const step = BUCKET_MS[bucket];
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        with cohorts as (
          select p.id, ${cohortAt} as cohort
          from participants p
          where (extract(epoch from p.created_at) * 1000) >= ${w.from}
            and (extract(epoch from p.created_at) * 1000) < ${w.to}
        ),
        acts as (select participant_id, ${activeAt} as at from (${activity}) a)
        select c.cohort,
               ((a.at - c.cohort) / ${step})::int as period,
               count(distinct c.id)::int          as learners
        from cohorts c
        join acts a on a.participant_id = c.id and a.at >= c.cohort
        group by 1, 2 order by 1, 2
      `),
    ).map((r) => ({ cohort: n(r.cohort), period: n(r.period), learners: n(r.learners) }));
  }

  /** Cohort sizes, so period 0 is not mistaken for "everyone who signed up". */
  async cohortSizes(w: Window, bucket: Bucket): Promise<Array<{ cohort: number; size: number }>> {
    const cohortAt = bucketMs(sql`(extract(epoch from created_at) * 1000)::bigint`, bucket);
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select ${cohortAt} as cohort, count(*)::int as size
        from participants
        where (extract(epoch from created_at) * 1000) >= ${w.from}
          and (extract(epoch from created_at) * 1000) < ${w.to}
        group by 1 order by 1
      `),
    ).map((r) => ({ cohort: n(r.cohort), size: n(r.size) }));
  }

  // ── visits ─────────────────────────────────────────────────────────────────
  async visitSeries(w: Window, bucket: Bucket): Promise<VisitPointRow[]> {
    const at = bucketMs(sql`started_at`, bucket);
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select ${at} as at,
          count(*)::int                                            as visits,
          count(distinct coalesce(participant_id, id))::int        as visitors,
          count(*) filter (where signed_in)::int                   as signed_in,
          count(*) filter (where not signed_in)::int               as anonymous,
          coalesce(sum(active_ms), 0)::bigint                      as active_ms,
          count(*) filter (where views <= 1 and sessions_started = 0)::int as bounces,
          coalesce(sum(sessions_started), 0)::int                  as sessions_started
        from site_visits
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1 order by 1
      `),
    ).map((r) => ({
      at: n(r.at),
      visits: n(r.visits),
      visitors: n(r.visitors),
      signedIn: n(r.signed_in),
      anonymous: n(r.anonymous),
      activeMs: n(r.active_ms),
      bounces: n(r.bounces),
      sessionsStarted: n(r.sessions_started),
    }));
  }

  async visitTotals(w: Window): Promise<VisitTotals> {
    const r =
      rowsOf<Record<string, unknown>>(
        await this.db.execute(sql`
          select count(*)::int as visits,
            count(distinct coalesce(participant_id, id))::int as visitors,
            coalesce(sum(active_ms), 0)::bigint               as active_ms,
            percentile_disc(0.5) within group (order by active_ms) as median_active_ms,
            count(*) filter (where views <= 1 and sessions_started = 0)::int as bounces,
            coalesce(sum(sessions_started), 0)::int           as sessions_started,
            count(*) filter (where sessions_started > 0)::int as converting
          from site_visits where started_at >= ${w.from} and started_at < ${w.to}
        `),
      )[0] ?? {};
    const visits = n(r.visits);
    return {
      visits,
      visitors: n(r.visitors),
      activeMs: n(r.active_ms),
      medianActiveMs: n(r.median_active_ms),
      bounceRate: visits > 0 ? n(r.bounces) / visits : 0,
      sessionsStarted: n(r.sessions_started),
      conversion: visits > 0 ? n(r.converting) / visits : 0,
    };
  }

  async visitsByScreen(
    w: Window,
    limit = 50,
  ): Promise<Array<{ screen: string; views: number; visits: number; activeMs: number }>> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select screen, coalesce(sum(views), 0)::int as views,
               count(distinct visit_id)::int        as visits,
               coalesce(sum(active_ms), 0)::bigint  as active_ms
        from site_visit_screens
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1 order by 2 desc limit ${limit}
      `),
    ).map((r) => ({
      screen: s(r.screen) ?? '',
      views: n(r.views),
      visits: n(r.visits),
      activeMs: n(r.active_ms),
    }));
  }

  async visitsByReferrer(
    w: Window,
    limit = 50,
  ): Promise<
    Array<{
      referrerHost: string | null;
      campaignSource: string | null;
      visits: number;
      sessionsStarted: number;
    }>
  > {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select referrer_host, campaign_source, count(*)::int as visits,
               coalesce(sum(sessions_started), 0)::int as sessions_started
        from site_visits
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1, 2 order by 3 desc limit ${limit}
      `),
    ).map((r) => ({
      referrerHost: s(r.referrer_host),
      campaignSource: s(r.campaign_source),
      visits: n(r.visits),
      sessionsStarted: n(r.sessions_started),
    }));
  }

  // ── where and on what ──────────────────────────────────────────────────────
  async geography(w: Window, limit = 200): Promise<GeographyRowOut[]> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select country, region, city, geo_source,
               count(*)::int                                     as visits,
               count(distinct coalesce(participant_id, id))::int as visitors,
               coalesce(sum(active_ms), 0)::bigint               as active_ms,
               coalesce(sum(sessions_started), 0)::int           as sessions
        from site_visits
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1, 2, 3, 4 order by 5 desc limit ${limit}
      `),
    ).map((r) => ({
      country: s(r.country),
      region: s(r.region),
      city: s(r.city),
      source: s(r.geo_source) ?? 'none',
      visits: n(r.visits),
      visitors: n(r.visitors),
      activeMs: n(r.active_ms),
      sessions: n(r.sessions),
    }));
  }

  async devices(w: Window, limit = 100): Promise<DeviceRowOut[]> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select device_type, os, browser,
               count(*)::int                                     as visits,
               count(distinct coalesce(participant_id, id))::int as visitors,
               coalesce(sum(active_ms), 0)::bigint               as active_ms,
               coalesce(sum(sessions_started), 0)::int           as sessions
        from site_visits
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1, 2, 3 order by 4 desc limit ${limit}
      `),
    ).map((r) => ({
      deviceType: s(r.device_type) ?? 'unknown',
      os: s(r.os),
      browser: s(r.browser),
      visits: n(r.visits),
      visitors: n(r.visitors),
      activeMs: n(r.active_ms),
      sessions: n(r.sessions),
    }));
  }

  /**
   * When people learn. Sessions are counted in UTC because a session row has
   * no clock of its own; visits are counted in the visitor's own hour, using
   * the offset their browser reported — which is the only version of this
   * number that means anything to a person reading it.
   */
  async usageClock(w: Window): Promise<UsageClockReport> {
    const sessions = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select extract(dow  from to_timestamp(started_at / 1000.0) at time zone 'UTC')::int as dow,
               extract(hour from to_timestamp(started_at / 1000.0) at time zone 'UTC')::int as hour,
               count(*)::int as sessions
        from session_stats
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1, 2 order by 1, 2
      `),
    ).map((r) => ({ dayOfWeek: n(r.dow), hour: n(r.hour), n: n(r.sessions) }));
    const visits = rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select extract(dow  from to_timestamp((started_at + coalesce(utc_offset_minutes, 0) * 60000) / 1000.0) at time zone 'UTC')::int as dow,
               extract(hour from to_timestamp((started_at + coalesce(utc_offset_minutes, 0) * 60000) / 1000.0) at time zone 'UTC')::int as hour,
               count(*)::int as visits,
               coalesce(sum(active_ms), 0)::bigint as active_ms
        from site_visits
        where started_at >= ${w.from} and started_at < ${w.to}
        group by 1, 2 order by 1, 2
      `),
    ).map((r) => ({
      dayOfWeek: n(r.dow),
      hour: n(r.hour),
      n: n(r.visits),
      activeMs: n(r.active_ms),
    }));
    return { window: w, sessionsUtc: sessions, visitsLocal: visits };
  }

  // ── subscriptions ──────────────────────────────────────────────────────────
  /** The plan mix now, and how it moved inside the window. */
  async planMix(w: Window): Promise<PlanMixRow[]> {
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select p.plan, p.plan_interval, p.plan_status,
               count(*)::int as participants,
               count(*) filter (where a.host_id is not null)::int as active
        from participants p
        left join (
          select distinct host_id from session_stats
          where started_at >= ${w.from} and started_at < ${w.to}
        ) a on a.host_id = p.id
        group by 1, 2, 3 order by 4 desc
      `),
    ).map((r) => ({
      plan: s(r.plan) ?? 'free',
      interval: s(r.plan_interval) as 'month' | 'year' | null,
      status: s(r.plan_status),
      participants: n(r.participants),
      active: n(r.active),
    }));
  }

  async planChanges(w: Window, bucket: Bucket): Promise<PlanChangeRow[]> {
    const at = bucketMs(sql`at`, bucket);
    return rowsOf<Record<string, unknown>>(
      await this.db.execute(sql`
        select ${at} as at,
          count(*) filter (where from_plan is distinct from to_plan and to_plan <> 'free')::int as upgrades,
          count(*) filter (where to_plan = 'free')::int                                        as cancellations,
          count(*) filter (where interval = 'month')::int                                      as monthly,
          count(*) filter (where interval = 'year')::int                                       as yearly,
          coalesce(sum(amount_cents) filter (where to_plan <> 'free'), 0)::int                 as amount_cents
        from plan_events
        where at >= ${w.from} and at < ${w.to}
        group by 1 order by 1
      `),
    ).map((r) => ({
      at: n(r.at),
      upgrades: n(r.upgrades),
      cancellations: n(r.cancellations),
      monthly: n(r.monthly),
      yearly: n(r.yearly),
      amountCents: n(r.amount_cents),
    }));
  }
}

/**
 * The only columns a caller may order by, as a `Map` rather than an object:
 * indexing an object with an untrusted string also finds `constructor` and
 * `toString`, which are truthy and are not SQL.
 */
const ORDERABLE = new Map<string, SQL>(
  Object.entries({
    startedAt: sql`t.started_at`,
    totalUsd: sql`t.total_usd`,
    durationMs: sql`t.duration_ms`,
    progress: sql`t.progress`,
    savedUsd: sql`t.saved_usd`,
    errors: sql`t.errors`,
    reusedBy: sql`r.reused_by`,
    views: sql`s.views`,
  }),
);

export interface PeopleSummary {
  accounts: number;
  newAccounts: number;
  anonymous: number;
  freeAccounts: number;
  paying: number;
  byPlan: { standard: number; professional: number };
  byInterval: { month: number; year: number };
  cancelling: number;
  visitors: number;
  returning: number;
  active: { day: number; week: number; month: number };
  learners: number;
  sessions: number;
  avgActiveMsPerVisitor: number;
  avgSessionMs: number;
  totalUsd: number;
  costPerLearnerUsd: number;
  costPerPayingUsd: number;
  revenueUsd: number;
  subscribed: number;
  churned: number;
}

export interface UserTotals {
  sessions: number;
  completed: number;
  totalUsd: number;
  sessionMs: number;
  visits: number;
  activeMs: number;
}

export interface PlanEventRow {
  at: number;
  fromPlan: string | null;
  toPlan: string;
  interval: 'month' | 'year' | null;
  status: string | null;
  source: string | null;
  amountCents: number | null;
  currency: string | null;
}

const USER_ORDER = new Map<string, SQL>(
  Object.entries({
    sessions: sql`coalesce(t.sessions, 0)`,
    totalUsd: sql`coalesce(t.total_usd, 0)`,
    activeMs: sql`coalesce(v.active_ms, 0)`,
    createdAt: sql`p.created_at`,
    lastSeenAt: sql`p.last_seen_at`,
  }),
);

const BUCKET_MS: Record<Bucket, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  // Months are not a fixed length; the cohort period is computed in days and
  // divided, which drifts by a day or two over a year. A monthly cohort grid
  // is read as "months later", so that is close enough and it is written down.
  month: 30 * 86_400_000,
};

function toSessionListRow(r: Record<string, unknown>): SessionListRow {
  return {
    sessionId: s(r.session_id) ?? '',
    topic: s(r.topic) ?? '',
    title: s(r.title) ?? '',
    hostId: s(r.host_id) ?? '',
    plan: s(r.plan) ?? 'free',
    expertId: s(r.expert_id) ?? '',
    language: s(r.language) ?? '',
    band: s(r.band) ?? '',
    domain: s(r.domain) ?? '',
    canonicalId: s(r.canonical_id),
    voiceEngine: s(r.voice_engine),
    voiceTts: s(r.voice_tts),
    startedAt: n(r.started_at),
    endedAt: nn(r.ended_at),
    durationMs: n(r.duration_ms),
    segmentsPlanned: n(r.segments_planned),
    segmentsReached: n(r.segments_reached),
    progress: n(r.progress),
    completed: b(r.completed),
    leaveReason: s(r.leave_reason) ?? 'unknown',
    lastStage: s(r.last_stage),
    lastInteraction: s(r.last_interaction),
    adPlayingAtEnd: b(r.ad_playing_at_end),
    lastErrorCode: s(r.last_error_code),
    questions: n(r.questions),
    interrupts: n(r.interrupts),
    participants: n(r.participants),
    errors: n(r.errors),
    totalUsd: n(r.total_usd),
    revenueUsd: n(r.revenue_usd),
    savedUsd: n(r.saved_usd),
    freshEquivalentUsd: n(r.fresh_equivalent_usd),
    packHit: b(r.pack_hit),
    timeToFirstAudioMs: nn(r.time_to_first_audio_ms),
    turnP50Ms: nn(r.turn_p50_ms),
    views: n(r.views),
    replays: n(r.replays),
    shares: n(r.shares),
    reusedBy: n(r.reused_by),
  };
}

// ── row shapes ───────────────────────────────────────────────────────────────
export interface OverviewReport {
  window: Window;
  sessions: number;
  completed: number;
  completionRate: number;
  learners: number;
  totalUsd: number;
  revenueUsd: number;
  savedUsd: number;
  freshEquivalentUsd: number;
  costPerSessionUsd: number;
  reuseRate: number;
  packHitRate: number;
  durationMs: number;
  avgDurationMs: number;
  avgProgress: number;
  errors: number;
  timeToFirstAudioP50Ms: number | null;
  timeToFirstAudioP95Ms: number | null;
  visits: number;
  visitors: number;
  activeMs: number;
  visitToSession: number;
}

export interface CostPointRow {
  at: number;
  sessions: number;
  totalUsd: number;
  llmUsd: number;
  intentUsd: number;
  imageUsd: number;
  ttsUsd: number;
  sttUsd: number;
  searchUsd: number;
  revenueUsd: number;
  freshEquivalentUsd: number;
  savedUsd: number;
}

export interface StageSummaryRow {
  stage: string;
  sessions: number;
  samples: number;
  failed: number;
  reused: number;
  usd: number;
  savedUsd: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface AbandonmentReport {
  window: Window;
  reasons: Array<{
    reason: string;
    sessions: number;
    avgProgress: number;
    avgDurationMs: number;
    avgSegmentReached: number;
  }>;
  bySegment: Array<{ segment: number; sessions: number }>;
  lastSeen: Array<{ lastInteraction: string; lastStage: string; sessions: number }>;
}

export interface ReuseTotals {
  window: Window;
  sessions: number;
  packHits: number;
  pictureReuses: number;
  cardReuses: number;
  memoSegmentsReused: number;
  memoSegmentsGenerated: number;
  ttsSentencesReused: number;
  ttsSentencesGenerated: number;
  contextSpeculationHits: number;
  savedUsd: number;
  totalUsd: number;
  freshEquivalentUsd: number;
  savedShare: number;
  byKind: Array<{ kind: string; links: number; uses: number; savedUsd: number }>;
}

export interface SessionQuery {
  window: Window;
  plan?: string | undefined;
  leaveReason?: string | undefined;
  hostId?: string | undefined;
  expertId?: string | undefined;
  voiceEngine?: string | undefined;
  completed?: boolean | undefined;
  /** One of `ORDERABLE`'s keys; anything else falls back to `startedAt`. */
  orderBy?: string | undefined;
  direction?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SessionListRow {
  sessionId: string;
  topic: string;
  title: string;
  hostId: string;
  plan: string;
  expertId: string;
  language: string;
  band: string;
  domain: string;
  canonicalId: string | null;
  voiceEngine: string | null;
  voiceTts: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  segmentsPlanned: number;
  segmentsReached: number;
  progress: number;
  completed: boolean;
  leaveReason: string;
  lastStage: string | null;
  lastInteraction: string | null;
  adPlayingAtEnd: boolean;
  lastErrorCode: string | null;
  questions: number;
  interrupts: number;
  participants: number;
  errors: number;
  totalUsd: number;
  revenueUsd: number;
  savedUsd: number;
  freshEquivalentUsd: number;
  packHit: boolean;
  timeToFirstAudioMs: number | null;
  turnP50Ms: number | null;
  views: number;
  replays: number;
  shares: number;
  reusedBy: number;
}

export interface SessionDetail {
  session: SessionListRow;
  downloads: number;
  exports: number;
  stages: Array<{
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
  }>;
  errors: Array<{
    code: string;
    stage: string | null;
    n: number;
    firstAtMs: number;
    lastAtMs: number;
  }>;
  /** What this session took from earlier work. */
  tookFrom: Array<{ kind: string; sourceSessionId: string | null; uses: number; savedUsd: number }>;
  /** What later sessions took from it, and the searches they were for. */
  gaveTo: {
    reusedBy: number;
    uses: number;
    savedForOthersUsd: number;
    byKind: Array<{ kind: string; uses: number; savedUsd: number }>;
    searches: Array<{ topic: string; uses: number; lastAt: number }>;
  };
}

export interface UserQuery {
  window: Window;
  orderBy?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface UserRow {
  id: string;
  name: string;
  plan: string;
  planInterval: string | null;
  anonymous: boolean;
  analyticsOptOut: boolean;
  createdAt: number;
  lastSeenAt: number;
  sessions: number;
  completed: number;
  totalUsd: number;
  sessionMs: number;
  visits: number;
  activeMs: number;
  country: string | null;
  deviceType: string | null;
}

export interface RetentionRow {
  cohort: number;
  period: number;
  learners: number;
}

export interface VisitPointRow {
  at: number;
  visits: number;
  visitors: number;
  signedIn: number;
  anonymous: number;
  activeMs: number;
  bounces: number;
  sessionsStarted: number;
}

export interface VisitTotals {
  visits: number;
  visitors: number;
  activeMs: number;
  medianActiveMs: number;
  bounceRate: number;
  sessionsStarted: number;
  conversion: number;
}

export interface GeographyRowOut {
  country: string | null;
  region: string | null;
  city: string | null;
  source: string;
  visits: number;
  visitors: number;
  activeMs: number;
  sessions: number;
}

export interface DeviceRowOut {
  deviceType: string;
  os: string | null;
  browser: string | null;
  visits: number;
  visitors: number;
  activeMs: number;
  sessions: number;
}

export interface UsageClockReport {
  window: Window;
  sessionsUtc: Array<{ dayOfWeek: number; hour: number; n: number }>;
  visitsLocal: Array<{ dayOfWeek: number; hour: number; n: number; activeMs: number }>;
}

export interface PlanMixRow {
  plan: string;
  interval: 'month' | 'year' | null;
  status: string | null;
  participants: number;
  active: number;
}

export interface PlanChangeRow {
  at: number;
  upgrades: number;
  cancellations: number;
  monthly: number;
  yearly: number;
  amountCents: number;
}
