import type { Cue, LedgerEntry, StageSample } from '@pen/contracts';
import { SessionTelemetry } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import {
  aggregateReuse,
  computeTelemetry,
  percentile,
  sessionEndedProperties,
  stageProperties,
  summariseCosts,
} from '../src/telemetry.js';

const base = {
  sessionId: 'sess-12345678',
  plan: 'free',
  expertId: 'ada-okonkwo',
  language: 'en-US',
};

const metric = (
  t: number,
  stage: StageSample['stage'],
  ms: number,
  meta: Record<string, string | number | boolean> = {},
  ok = true,
): LedgerEntry => ({ kind: 'metric', t: 1000 + t, sample: { stage, t, ms, ok, meta } });

const cue = (
  t: number,
  seq: number,
  segment: number,
  thread: string,
  event: Cue['event'],
): LedgerEntry => ({
  kind: 'cue',
  t: 1000 + t,
  cue: { seq, segment, thread, at: 1000 + t, event },
});

describe('percentile', () => {
  it('uses nearest rank and returns null for no samples', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(twenty, 50)).toBe(10);
    expect(percentile(twenty, 95)).toBe(19);
    expect(percentile(twenty, 100)).toBe(20);
  });
});

describe('summariseCosts', () => {
  it('sums usd and units per component and counts a model call once', () => {
    const { totalUsd, byComponent } = summariseCosts([
      { component: 'llm', unit: 'tokens_in', units: 600, usd: 0.00012, meta: {} },
      { component: 'llm', unit: 'tokens_cached', units: 900, usd: 0.000018, meta: {} },
      { component: 'llm', unit: 'tokens_out', units: 300, usd: 0.00036, meta: {} },
      { component: 'tts', unit: 'bytes', units: 120, usd: 0.0018, meta: {} },
      { component: 'tts', unit: 'bytes', units: 80, usd: 0.0012, meta: {} },
      { component: 'onten', unit: 'requests', units: 1, usd: 0, meta: {} },
    ]);
    expect(totalUsd).toBeCloseTo(0.003498, 9);
    expect(byComponent.llm).toEqual({
      usd: expect.closeTo(0.000498, 9),
      calls: 1,
      units: { tokens_in: 600, tokens_cached: 900, tokens_out: 300 },
    });
    expect(byComponent.tts).toEqual({
      usd: expect.closeTo(0.003, 9),
      calls: 2,
      units: { bytes: 200 },
    });
    expect(byComponent.onten?.calls).toBe(1);
    expect(byComponent.stt).toBeUndefined();
  });
});

describe('computeTelemetry', () => {
  it('returns zeros and nulls for an empty ledger', () => {
    const t = computeTelemetry({ ...base, entries: [] });
    expect(SessionTelemetry.parse(t)).toEqual(t);
    expect(t.totals).toEqual({
      durationMs: 0,
      segments: 0,
      says: 0,
      questions: 0,
      interrupts: 0,
      adsShown: 0,
      adsSkipped: 0,
      participants: 0,
    });
    expect(t.latency.timeToFirstAudioMs).toBeNull();
    expect(t.latency.questionToFirstAudioMs).toEqual({ p50: null, p95: null, n: 0 });
    expect(t.cost).toEqual({ totalUsd: 0, byComponent: {}, lines: [] });
  });

  it('derives totals, latencies and costs from a ledger', () => {
    const say = (id: string) => ({ type: 'say' as const, id, text: 'x', tone: 'warm' as const });
    const entries: LedgerEntry[] = [
      { kind: 'join', t: 1000, participantId: 'host-1234', name: 'Sam' },
      { kind: 'join', t: 1500, participantId: 'guest-001', name: 'Kim' },
      metric(0, 'join', 0, {
        role: 'host',
        plan: 'standard',
        expertId: 'ada-okonkwo',
        language: 'fr-FR',
      }),
      metric(5, 'intake', 2, { via: 'cache', reused: true, savedUsd: 0.0001 }),
      metric(20, 'resolve', 3, {
        match: 'hit',
        canonicalId: 'en.how-transformers-work-in-llms',
        timing: true,
      }),
      metric(25, 'resolve', 0, {
        match: 'hit',
        canonicalId: 'en.how-transformers-work-in-llms',
        reused: true,
        savedUsd: 0.05,
      }),
      metric(40, 'llm', 900, { purpose: 'plan', firstTokenMs: 400, reused: false }),
      metric(60, 'llm', 0, {
        purpose: 'lesson',
        firstTokenMs: -1,
        reused: true,
        memo: true,
        savedUsd: 0.004,
        segment: 0,
      }),
      metric(70, 'context', 4, {
        purpose: 'lesson-segment:v1',
        speculationHit: false,
        reused: false,
      }),
      metric(80, 'context', 1, {
        purpose: 'answer:v1',
        speculationHit: true,
        reused: true,
        savedUsd: 0,
      }),
      cue(1000, 0, 0, 'lesson', say('L0.s1')),
      cue(1100, 1, 0, 'lesson', say('L0.s2')),
      metric(1000, 'tts', 700, { firstChunkMs: 90, sayId: 'L0.s1' }),
      metric(1700, 'tts', 650, { firstChunkMs: 110, sayId: 'L0.s2' }),
      metric(1710, 'tts', 10, { firstChunkMs: -1, sayId: 'L0.s3' }, false),
      { kind: 'interrupt', t: 4000, participantId: 'host-1234', atSeq: 1, offsetMs: 300 },
      metric(4200, 'stt', 320, { provider: 'deepgram' }),
      metric(4520, 'llm', 1300, { purpose: 'turn', firstTokenMs: 350, reused: false }),
      metric(5300, 'llm', 1000, { purpose: 'lesson', firstTokenMs: 300, reused: false }),
      metric(4520, 'turn', 610, { thread: 't1' }),
      cue(4600, 2, 0, 'lesson', {
        type: 'note',
        language: 'en-US',
        question: 'q',
        headline: 'h',
        detail: 'd',
      }),
      cue(5200, 3, 1, 'lesson', say('L1.s1')),
      metric(6000, 'turn', 990, { thread: 't2' }),
      {
        kind: 'interaction',
        t: 1090,
        interaction: {
          t: 90,
          participantId: 'host-1234',
          event: 'first_audio',
          props: { 'latency.fromStartMs': 1450 },
        },
      },
      {
        kind: 'interaction',
        t: 5000,
        interaction: {
          t: 4000,
          participantId: 'host-1234',
          event: 'interrupt',
          props: { 'latency.bargeInMs': 18 },
        },
      },
      {
        kind: 'interaction',
        t: 5100,
        interaction: { t: 4100, participantId: 'host-1234', event: 'ad_shown', props: {} },
      },
      {
        kind: 'interaction',
        t: 5150,
        interaction: {
          t: 4150,
          participantId: 'host-1234',
          event: 'ad_skipped',
          props: { ms: 50 },
        },
      },
      {
        kind: 'cost',
        t: 1040,
        line: { component: 'llm', unit: 'tokens_in', units: 100, usd: 0.00002, meta: {} },
      },
      {
        kind: 'cost',
        t: 1040,
        line: { component: 'llm', unit: 'tokens_cached', units: 0, usd: 0, meta: {} },
      },
      {
        kind: 'cost',
        t: 1040,
        line: { component: 'llm', unit: 'tokens_out', units: 50, usd: 0.00006, meta: {} },
      },
      {
        kind: 'cost',
        t: 2000,
        line: { component: 'tts', unit: 'bytes', units: 40, usd: 0.0006, meta: {} },
      },
      {
        kind: 'cost',
        t: 4200,
        line: { component: 'stt', unit: 'seconds', units: 2.5, usd: 0.0002, meta: {} },
      },
      {
        kind: 'error',
        t: 2710,
        error: { t: 1710, code: 'TTS_UPSTREAM_502', stage: 'tts', ref: 'abc' },
      },
      { kind: 'mode', t: 9000, mode: 'complete', floor: null },
    ];
    const t = computeTelemetry({ ...base, entries });
    expect(SessionTelemetry.parse(t)).toEqual(t);
    expect(t.canonicalId).toBe('en.how-transformers-work-in-llms');
    expect(t.reuse).toEqual({
      packHit: true,
      memoSegmentsReused: 1,
      memoSegmentsGenerated: 1,
      contextSpeculationHits: 1,
      intakeCacheHit: true,
      savedUsd: expect.closeTo(0.0541, 9),
      freshEquivalentUsd: expect.closeTo(0.00088 + 0.0541, 9),
    });
    expect(t.totals).toEqual({
      durationMs: 8000,
      segments: 2,
      says: 3,
      questions: 1,
      interrupts: 1,
      adsShown: 1,
      adsSkipped: 1,
      participants: 2,
    });
    expect(t.latency.timeToFirstAudioMs).toBe(1450);
    expect(t.latency.questionToFirstAudioMs).toEqual({ p50: 610, p95: 990, n: 2 });
    expect(t.latency.llmFirstTokenMs).toEqual({ p50: 350, p95: 400, n: 3 });
    // The failed synthesis (firstChunkMs -1) is not a latency sample.
    expect(t.latency.ttsFirstChunkMs).toEqual({ p50: 90, p95: 110, n: 2 });
    expect(t.latency.sttFinalMs).toEqual({ p50: 320, p95: 320, n: 1 });
    expect(t.latency.bargeInMs).toEqual({ p50: 18, p95: 18, n: 1 });
    expect(t.cost.totalUsd).toBeCloseTo(0.00088, 9);
    expect(t.cost.byComponent.llm?.calls).toBe(1);
    expect(t.cost.byComponent.stt?.units.seconds).toBe(2.5);
    expect(t.stages.map((s) => s.t)).toEqual([...t.stages.map((s) => s.t)].sort((a, b) => a - b));
    expect(t.errors).toHaveLength(1);
    expect(t.interactions).toHaveLength(4);
  });

  it('falls back to the server-side first chunk when the client never reported first audio', () => {
    const t = computeTelemetry({
      ...base,
      entries: [metric(1200, 'tts', 700, { firstChunkMs: 90, sayId: 'L0.s1' })],
    });
    expect(t.latency.timeToFirstAudioMs).toBe(1290);
  });

  it('reads identity from the ledger when the caller does not know it', () => {
    const t = computeTelemetry({
      sessionId: 'sess-12345678',
      entries: [
        metric(0, 'join', 0, {
          role: 'host',
          plan: 'standard',
          expertId: 'ada-okonkwo',
          language: 'fr-FR',
        }),
        metric(5, 'resolve', 0, {
          canonicalId: 'en.swift-fundamentals',
          reused: false,
          savedUsd: 0,
        }),
      ],
    });
    expect(t).toMatchObject({
      plan: 'standard',
      expertId: 'ada-okonkwo',
      language: 'fr-FR',
      canonicalId: 'en.swift-fundamentals',
    });
    expect(t.reuse.packHit).toBe(false);
    expect(computeTelemetry({ sessionId: 'sess-12345678', entries: [] })).toMatchObject({
      plan: 'unknown',
      canonicalId: null,
    });
  });
});

describe('aggregateReuse', () => {
  const session = (
    canonicalId: string | null,
    cost: number,
    reuse: Partial<SessionTelemetry['reuse']>,
  ) => ({
    canonicalId,
    cost: { totalUsd: cost, byComponent: {}, lines: [] },
    reuse: {
      packHit: false,
      memoSegmentsReused: 0,
      memoSegmentsGenerated: 0,
      contextSpeculationHits: 0,
      intakeCacheHit: false,
      savedUsd: 0,
      freshEquivalentUsd: cost,
      ...reuse,
    },
  });

  it('groups by canonical topic with hit rates, averages and totals', () => {
    const stats = aggregateReuse([
      session('en.a', 0.1, { packHit: false, memoSegmentsGenerated: 4 }),
      session('en.a', 0.02, { packHit: true, memoSegmentsReused: 4, savedUsd: 0.08 }),
      session('en.a', 0.03, {
        packHit: true,
        memoSegmentsReused: 2,
        memoSegmentsGenerated: 2,
        savedUsd: 0.04,
      }),
      session('en.b', 0.2, { packHit: true, intakeCacheHit: true, contextSpeculationHits: 3 }),
      session(null, 0.01, {}),
    ]);
    expect(stats.topics.map((t) => t.canonicalId)).toEqual(['en.a', 'en.b', 'unresolved']);
    const a = stats.topics[0];
    expect(a).toMatchObject({
      sessions: 3,
      packHits: 2,
      packHitRate: 2 / 3,
      memoSegmentsReused: 6,
      memoSegmentsGenerated: 6,
      memoReuseRate: 0.5,
      totalSavedUsd: expect.closeTo(0.12, 9),
    });
    expect(a?.avgCostUsd).toBeCloseTo(0.05, 9);
    expect(a?.avgFreshEquivalentUsd).toBeCloseTo(0.09, 9);
    expect(stats.totals).toMatchObject({
      topics: 3,
      sessions: 5,
      packHits: 3,
      intakeCacheHits: 1,
      contextSpeculationHits: 3,
    });
    expect(stats.totals.totalCostUsd).toBeCloseTo(0.36, 9);
    expect(aggregateReuse([]).totals).toMatchObject({
      sessions: 0,
      packHitRate: 0,
      memoReuseRate: 0,
      avgCostUsd: 0,
    });
  });
});

describe('PostHog property shapes', () => {
  it('session_ended is flat: numbers, booleans, codes and nulls only', () => {
    const t = computeTelemetry({ ...base, entries: [] });
    const props = sessionEndedProperties(t, {
      completed: true,
      providers: { llm: 'openai', tts: 'fish-cloud:s2.1-pro', stt: 'browser' },
    });
    for (const [k, v] of Object.entries(props)) {
      expect(['number', 'boolean', 'string'].includes(typeof v) || v === null, k).toBe(true);
      if (typeof v === 'string') expect(v.length, k).toBeLessThanOrEqual(64);
    }
    expect(props).toMatchObject({
      sessionId: 'sess-12345678',
      canonicalId: null,
      plan: 'free',
      completed: true,
      'provider.tts': 'fish-cloud:s2.1-pro',
      'cost.totalUsd': 0,
      'latency.timeToFirstAudioMs': null,
      'latency.questionToFirstAudioP50': null,
      'cost.tokensIn': 0,
      'reuse.packHit': false,
      'reuse.savedUsd': 0,
      'reuse.freshEquivalentUsd': 0,
    });
    expect(Object.keys(props).length).toBeGreaterThan(40);
  });

  it('stage events flatten meta under a prefix', () => {
    expect(
      stageProperties('sess-12345678', {
        stage: 'tts',
        t: 10,
        ms: 90.5,
        ok: true,
        meta: { sayId: 'L0.s1', firstChunkMs: 80 },
      }),
    ).toEqual({
      sessionId: 'sess-12345678',
      stage: 'tts',
      t: 10,
      ms: 90.5,
      ok: true,
      'meta.sayId': 'L0.s1',
      'meta.firstChunkMs': 80,
    });
  });
});
