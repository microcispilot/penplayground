import type { LedgerEntry, StageSample } from '@pen/contracts';
import { FakeLanguageModel } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import { SessionMetrics } from '../src/metrics.js';
import { MAX_REPORTS_PER_PARTICIPANT, SessionRoom } from '../src/room.js';
import {
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  say,
  segmentScript,
  until,
} from './fixtures.js';

/**
 * A prepared topic taught by the fake model through the silent synthesizer,
 * with one typed question: every stage the engine owns must show up in the
 * ledger with a price, and client reports must become interactions / stages.
 */
describe('session telemetry (engine)', () => {
  it('records resolve/context/llm/tts/turn/join stages, cost lines, reports and errors in the ledger', async () => {
    const { onten } = await preparedPack();
    const transport = new MemoryTransport();
    const entries: LedgerEntry[] = [];
    const samples: StageSample[] = [];
    const startedAt = Date.now();
    const metrics = new SessionMetrics({
      sessionId: 'sess-telemetry',
      startedAt,
      ledger: { append: (_id, e) => entries.push(e) },
      onSample: (s) => samples.push(s),
    });
    const model = new FakeLanguageModel(
      [
        segmentScript(1, 2),
        segmentScript(2, 2),
        {
          match: (r) => r.purpose === 'turn',
          gapMs: 2,
          events: [
            {
              type: 'note',
              language: 'en-US',
              question: 'why?',
              headline: 'because',
              detail: 'detail',
            },
            say('s1', 'Because it keeps the scores in range.'),
            { type: 'done' },
          ],
        },
      ],
      [planCompletion(2), { purpose: 'recap', value: { points: ['one'] } }],
    );
    const errors: string[] = [];
    const room = new SessionRoom({
      sessionId: 'sess-telemetry',
      topic: 'How Transformers work in LLMs',
      host: { id: 'host-1234', name: 'Sam', plan: 'free' },
      expert,
      band: 'beginner',
      language: 'en',
      locale: 'en-US',
      onten,
      runtime: onten.newRuntime(),
      memo: onten.memo,
      model,
      synthesizer: {
        id: 'fish-cloud:s2.1-pro',
        // Real-priced engine id, silent audio: one 120 ms frame per sentence.
        async *synthesize(req) {
          if (req.text.includes('second sentence')) throw new Error('TTS_UPSTREAM_502: boom');
          yield {
            audioChunkId: 0,
            audioClockMs: 0,
            sampleRate: 44100,
            durationMs: 120,
            pcm: new Uint8Array(0),
            textSpan: null,
          };
        },
      },
      voice: 'v',
      sampleRate: 44100,
      transport,
      acquirer: null,
      targetMinutes: 2,
      metrics,
      observer: {
        event: () => undefined,
        error: (area) => {
          errors.push(area);
          return 'sentry-event-id';
        },
      },
    });
    await room.start();
    await until(() => transport.audio.some((h) => h.sayId === 'L0.s1' && h.final));
    await until(() => samples.some((s) => s.stage === 'tts' && !s.ok));

    // The learner asks; the acknowledgement is the first audible chunk of the turn.
    room.handle('host-1234', { kind: 'progress', seq: 0, clockMs: 1000 });
    room.handle('host-1234', { kind: 'interrupt', atSeq: 1, sayId: 'L0.s2', offsetMs: 100 });
    room.handle('host-1234', {
      kind: 'transcript',
      utteranceId: 'u1',
      text: 'Why do we divide by the square root of d?',
      final: true,
    });
    await until(() => samples.some((s) => s.stage === 'turn'));
    await until(() => transport.messages.some((m) => m.kind === 'turn_done'));

    // Client reports: interactions, and the host's board/ad timings become stages.
    room.handle('host-1234', {
      kind: 'report',
      event: 'board_done',
      props: { ms: 840, op: 'write', chars: 22, seq: 1 },
    });
    room.handle('host-1234', {
      kind: 'report',
      event: 'ad_skipped',
      props: { ms: 5200, adId: 'ad-1' },
    });
    room.handle('host-1234', {
      kind: 'report',
      event: 'error_shown',
      props: { code: 'PEN_MICROPHONE_DENIED', ref: 'client-ref' },
    });
    room.handle('host-1234', { kind: 'report', event: 'captions_off', props: {} });
    // A runaway client cannot grow the ledger without bound.
    for (let i = 0; i < MAX_REPORTS_PER_PARTICIPANT + 10; i++)
      room.handle('host-1234', { kind: 'report', event: 'fullscreen', props: {} });
    await room.end();

    const stages = new Set(samples.map((s) => s.stage));
    for (const stage of ['join', 'resolve', 'context', 'llm', 'tts', 'turn', 'board', 'ad'])
      expect(stages.has(stage as StageSample['stage']), stage).toBe(true);

    // Every sample sits on the session clock and carries what the Insights tab needs.
    for (const s of samples) {
      expect(s.t).toBeGreaterThanOrEqual(0);
      expect(s.ms).toBeGreaterThanOrEqual(0);
    }
    const llm = samples.filter((s) => s.stage === 'llm');
    expect(llm.map((s) => s.meta.purpose)).toEqual(
      expect.arrayContaining(['plan', 'lesson', 'turn', 'recap']),
    );
    expect(llm.every((s) => typeof s.meta.tokensIn === 'number')).toBe(true);
    const tts = samples.filter((s) => s.stage === 'tts');
    expect(
      tts.some((s) => s.ok && typeof s.meta.firstChunkMs === 'number' && s.meta.firstChunkMs >= 0),
    ).toBe(true);
    const failed = tts.find((s) => !s.ok);
    expect(failed?.meta).toMatchObject({ engine: 'fish-cloud:s2.1-pro', cancelled: false });
    const turn = samples.find((s) => s.stage === 'turn');
    expect(turn?.meta).toMatchObject({ thread: 't1', sayId: 't1.s0', ack: true, kind: 'question' });
    expect(turn?.ms).toBeLessThan(2000);
    const context = samples.filter((s) => s.stage === 'context');
    expect(context.map((s) => s.meta.purpose)).toEqual(
      expect.arrayContaining(['lesson-segment:v1', 'answer:v1']),
    );
    expect(samples.find((s) => s.stage === 'board')?.meta).toEqual({
      op: 'write',
      chars: 22,
      seq: 1,
    });
    expect(samples.find((s) => s.stage === 'ad')?.meta).toEqual({ adId: 'ad-1', skipped: true });

    // Costs: the model's tokens (three lines a call), the engine's bytes, Onten's requests.
    const costs = entries.flatMap((e) => (e.kind === 'cost' ? [e.line] : []));
    const byComponent = new Set(costs.map((c) => c.component));
    expect([...byComponent].sort()).toEqual(['llm', 'onten', 'tts']);
    const ttsUsd = costs.filter((c) => c.component === 'tts').reduce((n, c) => n + c.usd, 0);
    expect(ttsUsd).toBeGreaterThan(0);
    expect(costs.filter((c) => c.component === 'llm').length % 3).toBe(0);
    expect(costs.every((c) => c.usd >= 0 && c.units >= 0)).toBe(true);

    // Interactions and errors: the client's reports and the engine's failures, with their Sentry refs.
    const interactions = entries.flatMap((e) => (e.kind === 'interaction' ? [e.interaction] : []));
    expect(interactions.slice(0, 4).map((i) => i.event)).toEqual([
      'board_done',
      'ad_skipped',
      'error_shown',
      'captions_off',
    ]);
    expect(interactions.length).toBe(MAX_REPORTS_PER_PARTICIPANT);
    expect(interactions.every((i) => i.participantId === 'host-1234')).toBe(true);
    const errs = entries.flatMap((e) => (e.kind === 'error' ? [e.error] : []));
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'TTS_UPSTREAM_502', stage: 'tts', ref: 'sentry-event-id' }),
        expect.objectContaining({ code: 'PEN_MICROPHONE_DENIED', stage: null, ref: 'client-ref' }),
      ]),
    );
    expect(errors).toContain('tts');
    // No content anywhere in the telemetry entries.
    const text = JSON.stringify(entries.filter((e) => e.kind !== 'cue' && e.kind !== 'caption'));
    expect(text).not.toContain('square root');
    expect(text).not.toContain('first sentence');
  }, 20_000);
});
