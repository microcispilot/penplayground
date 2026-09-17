import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  CostLine,
  InteractionEvent,
  LedgerEntry,
  llmCostLines,
  priceUsd,
  SessionTelemetry,
  StageSample,
  searchUsd,
  sttUsd,
  ttsUsd,
} from '../src/index.js';

describe('telemetry contracts', () => {
  it('accepts a stage sample with bounded meta', () => {
    const s = StageSample.parse({
      stage: 'llm',
      t: 120,
      ms: 840.5,
      ok: true,
      meta: { purpose: 'turn', firstTokenMs: 310, model: 'gpt-5.6-luna', cached: true },
    });
    expect(s.meta.firstTokenMs).toBe(310);
    expect(() =>
      StageSample.parse({ stage: 'llm', t: 0, ms: 1, ok: true, meta: { text: 'x'.repeat(65) } }),
    ).toThrow();
    expect(() => StageSample.parse({ stage: 'nope', t: 0, ms: 1, ok: true, meta: {} })).toThrow();
  });

  it('validates the report wire message and rejects content-sized props', () => {
    const ok = ClientMessage.parse({
      kind: 'report',
      event: 'question_typed',
      props: { chars: 42 },
    });
    expect(ok.kind === 'report' && ok.props.chars).toBe(42);
    const defaulted = ClientMessage.parse({ kind: 'report', event: 'pause' });
    expect(defaulted.kind === 'report' && defaulted.props).toEqual({});
    expect(
      ClientMessage.safeParse({
        kind: 'report',
        event: 'question_typed',
        props: { text: 'x'.repeat(65) },
      }).success,
    ).toBe(false);
    expect(ClientMessage.safeParse({ kind: 'report', event: 'typed_something' }).success).toBe(
      false,
    );
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
    expect(
      ClientMessage.safeParse({ kind: 'report', event: 'pause', props: tooMany }).success,
    ).toBe(false);
  });

  it('carries telemetry as ledger entries', () => {
    const entries = [
      {
        kind: 'metric',
        t: 1,
        sample: { stage: 'tts', t: 0, ms: 90, ok: true, meta: { sayId: 'L0.s1' } },
      },
      {
        kind: 'cost',
        t: 1,
        line: { component: 'tts', unit: 'bytes', units: 120, usd: 0.0018, meta: {} },
      },
      {
        kind: 'interaction',
        t: 2,
        interaction: { t: 1, participantId: 'p_12345678', event: 'pause', props: {} },
      },
      { kind: 'error', t: 3, error: { t: 2, code: 'room.answer', stage: 'llm', ref: null } },
    ];
    for (const e of entries) expect(LedgerEntry.safeParse(e).success).toBe(true);
    expect(
      InteractionEvent.safeParse({ t: -1, participantId: 'p_12345678', event: 'pause', props: {} })
        .success,
    ).toBe(false);
    expect(
      CostLine.safeParse({ component: 'llm', unit: 'tokens_in', units: -1, usd: 0, meta: {} })
        .success,
    ).toBe(false);
  });

  it('the ad lifecycle is an interaction and its revenue estimate an `ads` cost line (ADR-0014)', () => {
    for (const event of [
      'ad_requested',
      'ad_loaded',
      'ad_started',
      'ad_first_quartile',
      'ad_midpoint',
      'ad_third_quartile',
      'ad_completed',
      'ad_skipped',
      'ad_error',
      'ad_clicked',
    ])
      expect(
        InteractionEvent.safeParse({
          t: 0,
          participantId: 'p_12345678',
          event,
          props: { adId: 'ad-1', slot: 'boundary', atMs: 5000 },
        }).success,
        event,
      ).toBe(true);
    expect(
      CostLine.safeParse({
        component: 'ads',
        unit: 'requests',
        units: 1,
        usd: 0.008,
        meta: { purpose: 'ad_revenue', estimate: true },
      }).success,
    ).toBe(true);
    // Still a magnitude: the sign lives in the component, never in usd.
    expect(
      CostLine.safeParse({ component: 'ads', unit: 'requests', units: 1, usd: -0.008, meta: {} })
        .success,
    ).toBe(false);
  });

  it('SessionTelemetry accepts a partial cost record', () => {
    const t = SessionTelemetry.parse({
      sessionId: 'sess-12345678',
      plan: 'free',
      expertId: 'ada-okonkwo',
      language: 'en-US',
      canonicalId: 'en.how-transformers-work-in-llms',
      totals: {
        durationMs: 0,
        segments: 0,
        says: 0,
        questions: 0,
        interrupts: 0,
        adsShown: 0,
        adsSkipped: 0,
        participants: 1,
      },
      latency: {
        timeToFirstAudioMs: null,
        questionToFirstAudioMs: { p50: null, p95: null, n: 0 },
        llmFirstTokenMs: { p50: null, p95: null, n: 0 },
        ttsFirstChunkMs: { p50: null, p95: null, n: 0 },
        sttFinalMs: { p50: null, p95: null, n: 0 },
        bargeInMs: { p50: null, p95: null, n: 0 },
      },
      cost: {
        totalUsd: 0,
        revenueUsd: 0,
        byComponent: { llm: { usd: 0, calls: 1, units: { tokens_in: 5 } } },
        lines: [],
      },
      reuse: {
        packHit: true,
        memoSegmentsReused: 2,
        memoSegmentsGenerated: 1,
        contextSpeculationHits: 0,
        intakeCacheHit: false,
        savedUsd: 0.01,
        freshEquivalentUsd: 0.01,
      },
      stages: [],
      interactions: [],
      errors: [],
    });
    expect(t.cost.byComponent.llm?.units.tokens_in).toBe(5);
  });
});

describe('pricing', () => {
  it('prices a luna call and splits it into lines that sum to the total', () => {
    const usd = priceUsd('gpt-5.6-luna', 1500, 900, 300);
    expect(usd).toBeCloseTo((600 * 0.2 + 900 * 0.02 + 300 * 1.2) / 1e6, 12);
    const lines = llmCostLines(
      { model: 'gpt-5.6-luna', inputTokens: 1500, cachedTokens: 900, outputTokens: 300 },
      { purpose: 'turn' },
    );
    expect(lines.map((l) => l.unit)).toEqual(['tokens_in', 'tokens_cached', 'tokens_out']);
    expect(lines.map((l) => l.units)).toEqual([600, 900, 300]);
    expect(lines.reduce((n, l) => n + l.usd, 0)).toBeCloseTo(usd, 12);
    expect(lines[0]?.meta).toEqual({ model: 'gpt-5.6-luna', purpose: 'turn' });
    // Unknown models are priced like the default so spend is never hidden.
    expect(priceUsd('mystery', 1000, 0, 0)).toBeCloseTo(priceUsd('gpt-5.6-luna', 1000, 0, 0), 12);
    expect(priceUsd('fake', 1000, 500, 100)).toBe(0);
  });

  it('prices TTS per UTF-8 byte, free for the free model and self-hosted engines', () => {
    expect(ttsUsd('fish-cloud:s2.1-pro', 1_000_000)).toBe(15);
    expect(ttsUsd('fish-cloud:s2.1-pro-free', 1_000_000)).toBe(0);
    expect(ttsUsd('fish-cloud:s2.9-future', 100)).toBeCloseTo(0.0015, 12);
    expect(ttsUsd('fish-bridge', 5000)).toBe(0);
    expect(ttsUsd('silent', 5000)).toBe(0);
  });

  it('prices STT per minute and search per request', () => {
    expect(sttUsd('deepgram', 60)).toBeCloseTo(0.0048, 12);
    expect(sttUsd('deepgram:nova-3', 30)).toBeCloseTo(0.0024, 12);
    expect(sttUsd('assemblyai', 3600)).toBeCloseTo(0.15, 12);
    expect(sttUsd('ws-relay', 3600)).toBe(0);
    expect(sttUsd('browser', 3600)).toBe(0);
    expect(searchUsd('tavily')).toBe(0.008);
    expect(searchUsd('searxng', 10)).toBe(0);
    expect(searchUsd('exa', 2)).toBeCloseTo(0.01, 12);
  });
});
