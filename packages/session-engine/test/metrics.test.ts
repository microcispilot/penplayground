import type { LedgerEntry, StageSample } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { NullMetrics, SessionMetrics } from '../src/metrics.js';

function harness(start = 1_000_000) {
  let now = start;
  const entries: LedgerEntry[] = [];
  const samples: StageSample[] = [];
  const m = new SessionMetrics({
    sessionId: 'sess-12345678',
    startedAt: start,
    ledger: { append: (_id, e) => entries.push(e) },
    onSample: (s) => samples.push(s),
    now: () => now,
  });
  return { m, entries, samples, tick: (ms: number) => (now += ms) };
}

describe('SessionMetrics', () => {
  it('times a stage relative to the session start and writes it to the ledger and the sink', () => {
    const { m, entries, samples, tick } = harness();
    tick(500);
    const timer = m.start('llm', { purpose: 'turn' });
    tick(120);
    timer.mark({ firstTokenMs: 120 });
    tick(300);
    const sample = timer.end(true, { tokensOut: 40 });
    expect(sample).toEqual({
      stage: 'llm',
      t: 500,
      ms: 420,
      ok: true,
      meta: { purpose: 'turn', firstTokenMs: 120, tokensOut: 40 },
    });
    expect(samples).toEqual([sample]);
    expect(entries[0]).toEqual({ kind: 'metric', t: 1_000_500, sample });
    // A second end is ignored.
    expect(timer.end(false)).toBe(sample);
    expect(entries).toHaveLength(1);
  });

  it('records samples measured elsewhere, costs, interactions and errors', () => {
    const { m, entries, tick } = harness();
    tick(2000);
    m.sample({ stage: 'stt', ms: 340, ok: true, meta: { provider: 'deepgram' } });
    m.cost({ component: 'stt', unit: 'seconds', units: 3.2, usd: 0.000256, meta: {} });
    m.interaction('p_12345678', 'pause', { at: 12 });
    m.error({ code: 'room.answer', stage: 'llm', ref: 'abc123' });
    expect(entries.map((e) => e.kind)).toEqual(['metric', 'cost', 'interaction', 'error']);
    const metric = entries[0];
    // Without an explicit start the stage is assumed to have just ended.
    expect(metric?.kind === 'metric' && metric.sample).toMatchObject({ t: 1660, ms: 340 });
    const interaction = entries[2];
    expect(interaction?.kind === 'interaction' && interaction.interaction).toEqual({
      t: 2000,
      participantId: 'p_12345678',
      event: 'pause',
      props: { at: 12 },
    });
    const error = entries[3];
    expect(error?.kind === 'error' && error.error).toEqual({
      t: 2000,
      code: 'room.answer',
      stage: 'llm',
      ref: 'abc123',
    });
  });

  it('bounds meta to the contract and survives a throwing sink or ledger', () => {
    const boom = new SessionMetrics({
      sessionId: 's',
      startedAt: 0,
      ledger: {
        append: () => {
          throw new Error('disk');
        },
      },
      onSample: () => {
        throw new Error('sink');
      },
    });
    const s = boom.sample({
      stage: 'tts',
      ms: 10.123,
      ok: true,
      meta: { long: 'x'.repeat(100), nan: Number.NaN, flag: true, n: 1.2600004 },
    });
    expect(s.meta).toEqual({ long: 'x'.repeat(64), flag: true, n: 1.26 });
    expect(s.ms).toBe(10.1);
  });

  it('NullMetrics records nothing and still hands out working timers', () => {
    const n = new NullMetrics();
    const t = n.start('llm');
    t.mark({ a: 1 });
    expect(t.end(true)).toBeNull();
    expect(n.elapsed()).toBe(0);
    n.cost({ component: 'llm', unit: 'tokens_in', units: 1, usd: 0, meta: {} });
    n.error({ code: 'x', stage: null, ref: null });
    n.interaction('p', 'pause');
  });
});
