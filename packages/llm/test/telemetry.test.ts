import type { CostLine, SampleInput, TelemetryPort } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeLanguageModel } from '../src/fake.js';
import { llmErrorCode, withTelemetry } from '../src/telemetry.js';

class Recorder implements TelemetryPort {
  samples: SampleInput[] = [];
  costs: CostLine[] = [];
  errors: Array<{ code: string }> = [];
  sample(s: SampleInput) {
    this.samples.push(s);
  }
  cost(c: CostLine) {
    this.costs.push(c);
  }
  error(e: { code: string }) {
    this.errors.push(e);
  }
}

const fake = () =>
  new FakeLanguageModel(
    [
      {
        match: (r) => r.purpose === 'turn',
        gapMs: 1,
        events: [{ type: 'say', id: 's1', text: 'Hi.', tone: 'warm' }, { type: 'done' }],
      },
    ],
    [{ purpose: 'grade', value: { verdict: 'correct' } }],
  );

describe('withTelemetry', () => {
  it('records one llm sample and three cost lines per streamed call', async () => {
    const rec = new Recorder();
    const model = withTelemetry(fake(), rec);
    const stream = model.streamEvents({
      messages: [],
      cacheKey: 'k',
      maxOutputTokens: 10,
      purpose: 'turn',
    });
    const events = [];
    for await (const ev of stream) events.push(ev);
    await stream.usage;
    expect(events).toHaveLength(2);
    expect(rec.samples).toHaveLength(1);
    const s = rec.samples[0];
    expect(s?.stage).toBe('llm');
    expect(s?.ok).toBe(true);
    expect(s?.meta).toMatchObject({
      purpose: 'turn',
      model: 'fake',
      tokensIn: 1200,
      tokensCached: 900,
      tokensOut: 300,
    });
    expect(typeof s?.meta?.firstTokenMs).toBe('number');
    expect(rec.costs.map((c) => c.unit)).toEqual(['tokens_in', 'tokens_cached', 'tokens_out']);
    expect(rec.costs.map((c) => c.units)).toEqual([300, 900, 300]);
    expect(rec.costs[0]?.meta).toMatchObject({ purpose: 'turn', model: 'fake' });
  });

  it('records completions and marks failures with an error', async () => {
    const rec = new Recorder();
    const model = withTelemetry(fake(), rec);
    const { value } = await model.complete({
      messages: [],
      schema: z.object({ verdict: z.string() }),
      schemaName: 'g',
      cacheKey: 'k',
      maxOutputTokens: 10,
      purpose: 'grade',
    });
    expect(value.verdict).toBe('correct');
    expect(rec.samples[0]).toMatchObject({ stage: 'llm', ok: true });
    await expect(
      model.complete({
        messages: [],
        schema: z.object({}),
        schemaName: 'x',
        cacheKey: 'k',
        maxOutputTokens: 1,
        purpose: 'missing',
      }),
    ).rejects.toThrow();
    expect(rec.samples[1]).toMatchObject({ stage: 'llm', ok: false });
    expect(rec.samples[1]?.meta?.code).toBe('LLM_ERROR');
    // Errors are the caller's to record, with the Sentry ref it captured.
    expect(rec.errors).toHaveLength(0);
  });

  it('turns provider errors into stable codes without their message', () => {
    expect(llmErrorCode(new Error('LLM_REFUSAL: I cannot help with that'))).toBe('LLM_REFUSAL');
    expect(llmErrorCode(new Error('TTS_UPSTREAM_502: gateway'))).toBe('LLM_TTS_UPSTREAM_502');
    expect(llmErrorCode(new Error('connect ECONNREFUSED 1.2.3.4'))).toBe('LLM_ERROR');
    expect(llmErrorCode('boom')).toBe('LLM_ERROR');
  });
});
