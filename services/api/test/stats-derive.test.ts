import type { LedgerEntry, StageSample } from '@pen/contracts';
import { STATS_SCHEMA_VERSION } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import { describe, expect, it } from 'vitest';
import { deriveSession, scopeKeyFor } from '../src/stats/derive.js';
import { computeTelemetry } from '../src/telemetry.js';

/**
 * The derivation is pure, so every case here is a ledger in and rows out —
 * no database, no disk, no clock.
 */

const record = (patch: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 's_test_0001',
  topic: 'how compilers work',
  title: 'How compilers work',
  promise: '',
  expertId: 'ada-lovelace',
  hostId: 'p_host_000001',
  hostName: 'Ada',
  band: 'beginner',
  domain: 'computing',
  visibility: 'public',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_600_000,
  durationMs: 600_000,
  segments: 4,
  questions: 0,
  recap: [],
  views: 0,
  thumbnail: null,
  canonicalId: 'en.how-compilers-work',
  language: 'en-US',
  description: '',
  keywords: [],
  likes: 0,
  ...patch,
});

const metric = (t: number, sample: Omit<StageSample, 't'>): LedgerEntry => ({
  kind: 'metric',
  t,
  sample: { ...sample, t },
});

const derive = (entries: LedgerEntry[], patch: Partial<SessionRecord> = {}, opts = {}) => {
  const r = record(patch);
  return deriveSession({
    telemetry: computeTelemetry({
      sessionId: r.id,
      expertId: r.expertId,
      language: r.language,
      entries,
    }),
    record: r,
    ledgerEntries: entries.length,
    derivedAt: 1_700_000_700_000,
    ...opts,
  });
};

/** A session that ran normally: four segments taught, one question, a recap. */
function fullLesson(): LedgerEntry[] {
  const entries: LedgerEntry[] = [
    metric(0, { stage: 'join', ms: 0, ok: true, meta: { role: 'host', plan: 'standard' } }),
    { kind: 'voice_engine', t: 1, engine: 'cartesia', tts: 'cartesia:sonic-3.6+d1' },
    metric(10, {
      stage: 'resolve',
      ms: 0,
      ok: true,
      meta: { canonicalId: 'en.how-compilers-work', reused: false, savedUsd: 0 },
    }),
    metric(20, {
      stage: 'llm',
      ms: 900,
      ok: true,
      meta: { purpose: 'plan', firstTokenMs: 300, reused: false },
    }),
  ];
  for (let segment = 0; segment < 4; segment += 1) {
    entries.push(
      metric(1000 + segment * 1000, {
        stage: 'llm',
        ms: 700,
        ok: true,
        meta: { purpose: 'lesson', firstTokenMs: 200, reused: false },
      }),
      {
        kind: 'cue',
        t: 1100 + segment * 1000,
        cue: {
          seq: segment,
          thread: 'lesson',
          segment,
          at: 0,
          event: { type: 'say', id: `s${segment}`, text: 'x', tone: 'neutral' },
        },
      } as LedgerEntry,
      metric(1200 + segment * 1000, {
        stage: 'tts',
        ms: 400,
        ok: true,
        meta: { firstChunkMs: 120, reused: false },
      }),
    );
    entries.push({
      kind: 'cost',
      t: 1250 + segment * 1000,
      line: { component: 'tts', unit: 'bytes', units: 2048, usd: 0.002, meta: {} },
    } as LedgerEntry);
  }
  entries.push({
    kind: 'cost',
    t: 6000,
    line: { component: 'llm', unit: 'tokens_in', units: 5000, usd: 0.01, meta: {} },
  } as LedgerEntry);
  entries.push({
    kind: 'interaction',
    t: 6100,
    interaction: {
      t: 6100,
      participantId: 'p_host_000001',
      event: 'first_audio',
      props: { 'latency.fromStartMs': 1400 },
    },
  } as LedgerEntry);
  entries.push({
    kind: 'interaction',
    t: 8000,
    interaction: { t: 8000, participantId: 'p_host_000001', event: 'recap_shown', props: {} },
  } as LedgerEntry);
  return entries;
}

describe('deriveSession — the session row', () => {
  it('rolls totals, cost by component and latency percentiles out of the ledger', () => {
    const { session } = derive(fullLesson(), { recap: ['a', 'b'] });
    expect(session.schemaVersion).toBe(STATS_SCHEMA_VERSION);
    // The engine rides on the row (ADR-0048); a ledger without the entry leaves it null.
    expect(session.voiceEngine).toBe('cartesia');
    expect(session.voiceTts).toBe('cartesia:sonic-3.6+d1');
    expect(
      derive(
        fullLesson().filter((e) => e.kind !== 'voice_engine'),
        { recap: [] },
      ).session.voiceEngine,
    ).toBeNull();
    expect(session.segmentsPlanned).toBe(4);
    expect(session.segmentsReached).toBe(4);
    expect(session.progress).toBe(1);
    expect(session.says).toBe(4);
    // Four tts lines at $0.002 plus one llm line at $0.01.
    expect(session.ttsUsd).toBeCloseTo(0.008, 6);
    expect(session.llmUsd).toBeCloseTo(0.01, 6);
    expect(session.totalUsd).toBeCloseTo(0.018, 6);
    expect(session.tokensIn).toBe(5000);
    expect(session.timeToFirstAudioMs).toBe(1400);
    // The tts percentile is the first *chunk*, off `meta.firstChunkMs` — not
    // how long the whole sentence took to synthesise.
    expect(session.ttsFirstChunkP50Ms).toBe(120);
    expect(session.hostOptedOut).toBe(false);
  });

  it('is complete when the room says so, and infers it from a recap and full progress otherwise', () => {
    expect(derive(fullLesson(), {}, { completed: true }).session.leaveReason).toBe('completed');
    // No recap on the record and no `completed` from the caller: not complete.
    expect(derive(fullLesson(), { recap: [] }).session.completed).toBe(false);
    expect(derive(fullLesson(), { recap: ['one'] }).session.completed).toBe(true);
  });

  it('records the last stage and the last thing the learner saw', () => {
    const { session } = derive(fullLesson());
    expect(session.lastStage).toBe('tts');
    expect(session.lastInteraction).toBe('recap_shown');
  });
});

describe('deriveSession — why they stopped', () => {
  it('never_started: the room was never audible', () => {
    const { session } = derive([
      metric(0, { stage: 'join', ms: 0, ok: true, meta: { role: 'host' } }),
      metric(10, { stage: 'resolve', ms: 40, ok: true, meta: { canonicalId: 'en.x' } }),
    ]);
    expect(session.leaveReason).toBe('never_started');
    expect(session.progress).toBe(0);
  });

  it('left_during_ad: an ad was shown and never reported ending', () => {
    const entries = fullLesson().slice(0, 12);
    entries.push({
      kind: 'interaction',
      t: 5000,
      interaction: { t: 5000, participantId: 'p_host_000001', event: 'ad_shown', props: {} },
    } as LedgerEntry);
    const { session } = derive(entries);
    expect(session.adPlayingAtEnd).toBe(true);
    expect(session.leaveReason).toBe('left_during_ad');
  });

  it('the same ad, reported ended, is not a reason to have left', () => {
    const entries = fullLesson().slice(0, 12);
    entries.push(
      {
        kind: 'interaction',
        t: 5000,
        interaction: { t: 5000, participantId: 'p_host_000001', event: 'ad_shown', props: {} },
      } as LedgerEntry,
      {
        kind: 'interaction',
        t: 5200,
        interaction: { t: 5200, participantId: 'p_host_000001', event: 'ad_ended', props: {} },
      } as LedgerEntry,
    );
    const { session } = derive(entries);
    expect(session.adPlayingAtEnd).toBe(false);
    expect(session.leaveReason).toBe('left_mid_segment');
  });

  it('left_after_error: something failed just before the last event', () => {
    const entries = fullLesson().slice(0, 12);
    const last = Math.max(...entries.map((e) => e.t));
    entries.push({
      kind: 'error',
      t: last,
      error: { t: last, code: 'PEN_TTS_TIMEOUT', stage: 'tts', ref: null },
    } as LedgerEntry);
    const { session } = derive(entries);
    expect(session.lastErrorCode).toBe('PEN_TTS_TIMEOUT');
    expect(session.leaveReason).toBe('left_after_error');
  });

  it('an error long before the end is not why they left', () => {
    const entries = fullLesson();
    entries.push({
      kind: 'error',
      t: 100,
      error: { t: 100, code: 'PEN_STT_TIMEOUT', stage: 'stt', ref: null },
    } as LedgerEntry);
    // Two minutes of lesson after it: well outside ABANDON_ERROR_WINDOW_MS.
    entries.push({
      kind: 'interaction',
      t: 120_000,
      interaction: { t: 120_000, participantId: 'p_host_000001', event: 'note_shown', props: {} },
    } as LedgerEntry);
    const { session } = derive(entries, { recap: [] });
    expect(session.errors).toBe(1);
    expect(session.lastErrorCode).toBeNull();
    expect(session.leaveReason).toBe('left_mid_segment');
  });

  it('length_ceiling and idle_timeout come from the sweeper, not the ledger', () => {
    expect(
      derive(fullLesson(), { recap: [] }, { endReason: 'length_ceiling' }).session.leaveReason,
    ).toBe('length_ceiling');
    const quiet = derive(
      [
        metric(0, { stage: 'join', ms: 0, ok: true, meta: { role: 'host' } }),
        metric(10, { stage: 'tts', ms: 100, ok: true, meta: { firstChunkMs: 50 } }),
      ],
      { segments: 0 },
      { endReason: 'idle' },
    );
    expect(quiet.session.leaveReason).toBe('idle_timeout');
  });

  it('progress is the share of the planned segments that were reached', () => {
    const entries = fullLesson().filter(
      (e) => !(e.kind === 'cue' && e.cue.thread === 'lesson' && e.cue.segment >= 2),
    );
    const { session } = derive(entries, { recap: [] });
    expect(session.segmentsReached).toBe(2);
    expect(session.progress).toBe(0.5);
    expect(session.leaveReason).toBe('left_mid_segment');
  });
});

describe('deriveSession — per stage and per error', () => {
  it('groups samples by stage with counts, percentiles and attributed spend', () => {
    const { stages } = derive(fullLesson());
    const tts = stages.find((s) => s.stage === 'tts');
    expect(tts).toBeDefined();
    expect(tts?.samples).toBe(4);
    expect(tts?.ok).toBe(4);
    expect(tts?.failed).toBe(0);
    expect(tts?.usd).toBeCloseTo(0.008, 6);
    const llm = stages.find((s) => s.stage === 'llm');
    expect(llm?.samples).toBe(5);
    expect(llm?.p50Ms).toBe(700);
  });

  it('counts each error code once with its first and last moment', () => {
    const entries = fullLesson();
    for (const t of [100, 200, 300])
      entries.push({
        kind: 'error',
        t,
        error: { t, code: 'TTS_UPSTREAM_502', stage: 'tts', ref: null },
      } as LedgerEntry);
    const { errors } = derive(entries);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'TTS_UPSTREAM_502',
      n: 3,
      firstAtMs: 100,
      lastAtMs: 300,
    });
  });
});

describe('deriveSession — reuse provenance', () => {
  it('a fresh session claims the scopes it generated and reuses nothing', () => {
    const { generated, reused } = derive(fullLesson());
    expect(reused).toEqual([]);
    expect(generated.map((g) => g.kind).sort()).toEqual(['lesson', 'pack', 'voice']);
    expect(generated.find((g) => g.kind === 'pack')?.scopeKey).toBe('en.how-compilers-work');
    expect(generated.find((g) => g.kind === 'lesson')?.scopeKey).toBe(
      'en.how-compilers-work|beginner|ada-lovelace|en-US',
    );
  });

  it('a second learner of the same topic reuses the pack, the lesson and the voice, with what it saved', () => {
    const entries: LedgerEntry[] = [
      metric(0, { stage: 'join', ms: 0, ok: true, meta: { role: 'host' } }),
      metric(10, {
        stage: 'resolve',
        ms: 0,
        ok: true,
        meta: { canonicalId: 'en.how-compilers-work', reused: true, savedUsd: 0.4, viaApi: true },
      }),
      metric(20, {
        stage: 'llm',
        ms: 0,
        ok: true,
        meta: { purpose: 'plan', firstTokenMs: -1, reused: true, memo: true, savedUsd: 0.02 },
      }),
    ];
    for (let segment = 0; segment < 4; segment += 1) {
      entries.push(
        metric(100 + segment, {
          stage: 'llm',
          ms: 0,
          ok: true,
          meta: { purpose: 'lesson', reused: true, memo: true, savedUsd: 0.01 },
        }),
        {
          kind: 'cue',
          t: 110 + segment,
          cue: {
            seq: segment,
            thread: 'lesson',
            segment,
            at: 0,
            event: { type: 'say', id: `s${segment}`, text: 'x', tone: 'neutral' },
          },
        } as LedgerEntry,
        metric(120 + segment, {
          stage: 'tts',
          ms: 5,
          ok: true,
          meta: { firstChunkMs: 3, reused: true, savedUsd: 0.003 },
        }),
      );
    }
    entries.push(
      metric(500, {
        stage: 'image',
        ms: 0,
        ok: true,
        meta: { purpose: 'session_thumbnail', reused: true, savedUsd: 0.016 },
      }),
      metric(510, {
        stage: 'llm',
        ms: 0,
        ok: true,
        meta: { purpose: 'session_meta', reused: true, memo: true, savedUsd: 0.004 },
      }),
    );
    const { session, reused, generated } = derive(entries);
    expect(session.packHit).toBe(true);
    expect(session.memoSegmentsReused).toBe(4);
    expect(session.imageReused).toBe(true);
    expect(session.cardReused).toBe(true);
    expect(generated).toEqual([]);

    const byKind = Object.fromEntries(reused.map((r) => [r.kind, r]));
    expect(Object.keys(byKind).sort()).toEqual(['card', 'lesson', 'pack', 'picture', 'voice']);
    expect(byKind.pack?.savedUsd).toBeCloseTo(0.4, 6);
    // Four lesson segments at $0.01, plus the plan that arrived with the memo.
    expect(byKind.lesson?.uses).toBe(4);
    expect(byKind.lesson?.savedUsd).toBeCloseTo(0.06, 6);
    expect(byKind.voice?.uses).toBe(4);
    expect(byKind.voice?.savedUsd).toBeCloseTo(0.012, 6);
    // The voice store's scope carries no language: that is how `cache.ts` keys it.
    expect(byKind.voice?.scopeKey).toBe('en.how-compilers-work|beginner|ada-lovelace');
    expect(session.savedUsd).toBeGreaterThan(0.4);
    expect(session.freshEquivalentUsd).toBeCloseTo(session.totalUsd + session.savedUsd, 6);
  });

  it('a session that never resolved has no scope to have shared', () => {
    const { generated, reused, session } = derive(
      [metric(0, { stage: 'join', ms: 0, ok: true, meta: { role: 'host' } })],
      { canonicalId: null },
    );
    expect(session.scopeKey).toBeNull();
    expect(generated).toEqual([]);
    expect(reused).toEqual([]);
  });
});

describe('scopeKeyFor', () => {
  const scope = {
    canonicalId: 'en.x',
    band: 'beginner',
    expertId: 'ada',
    language: 'en-US',
  };
  it('spells each key the way the module that owns the memo spells it', () => {
    expect(scopeKeyFor('pack', scope)).toBe('en.x');
    expect(scopeKeyFor('voice', scope)).toBe('en.x|beginner|ada');
    expect(scopeKeyFor('lesson', scope)).toBe('en.x|beginner|ada|en-US');
    expect(scopeKeyFor('card', scope)).toBe(scopeKeyFor('lesson', scope));
    expect(scopeKeyFor('picture', scope)).toBe(scopeKeyFor('lesson', scope));
  });
  it('is null without a canonical topic', () => {
    expect(scopeKeyFor('lesson', { ...scope, canonicalId: null })).toBeNull();
  });
});
