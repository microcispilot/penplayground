import { describe, expect, it } from 'vitest';
import type { CostMeter, Usage } from '../src/index.js';
import { decisionErrorCode, JevDecisionsModel } from '../src/index.js';

/** The response shape measured against the live endpoint on 2026-09-19. */
const liveAnswer = {
  model: 'typesafe/jev-1.13',
  answers: {
    intent: {
      type: 'choice',
      choice: 'command',
      probabilities: { command: 1, clarify: 0 },
      confidence: 1,
    },
    command: { type: 'choice', choice: 'next', probabilities: { next: 0.99 }, confidence: 0.99 },
  },
  usage: { input_tokens: 685, output_tokens: 128, cost: 0.00002877 },
  provider: 'TypeSafe',
};

function stub(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const model = (fetch: typeof globalThis.fetch, timeoutMs = 600, meter?: CostMeter) =>
  new JevDecisionsModel({
    apiKey: 'test-key',
    model: 'typesafe/jev-1.13',
    timeoutMs,
    fetch,
    ...(meter ? { meter } : {}),
  });

const request = {
  state: 'the situation',
  purpose: 'intent',
  questions: {
    intent: { instructions: 'what?', criteria: { command: 'a', clarify: 'b' } },
  },
};

describe('JevDecisionsModel', () => {
  it('posts the decisions body and returns every answer with its confidence', async () => {
    const { fetch, calls } = stub(() => json(liveAnswer));
    const result = await model(fetch).decide(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toBe('the situation');
    // Both are required by the endpoint; each was learned from its own 400.
    expect(body.questions.intent.criteria).toEqual({ command: 'a', clarify: 'b' });
    expect(body.questions.intent.type).toBe('choice');

    expect(result.answers.intent).toMatchObject({ choice: 'command', confidence: 1 });
    expect(result.answers.command).toMatchObject({ choice: 'next', confidence: 0.99 });
  });

  it('prices the call from our own table and keeps what the provider reported', async () => {
    const recorded: Array<Usage & { purpose: string }> = [];
    const meter: CostMeter = { record: (u) => recorded.push(u) };
    const { usage } = await model(stub(() => json(liveAnswer)).fetch, 600, meter).decide(request);

    // 685 × $0.042 / 1M — the same number the endpoint reported for this call.
    expect(usage.usd).toBeCloseTo(0.00002877, 12);
    expect(usage.reportedUsd).toBeCloseTo(0.00002877, 12);
    expect(usage.inputTokens).toBe(685);
    expect(usage.outputTokens).toBe(128);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ purpose: 'intent', cachedTokens: 0, usd: usage.usd });
  });

  it('gives up on its own budget rather than holding the turn open', async () => {
    const { fetch } = stub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const error = await model(fetch, 20)
      .decide(request)
      .catch((e: unknown) => e);
    expect(decisionErrorCode(error)).toBe('DECISION_TIMEOUT');
  });

  it('tells a caller that gave up apart from a call that ran out of time', async () => {
    const { fetch } = stub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const caller = new AbortController();
    const pending = model(fetch, 5_000)
      .decide({ ...request, signal: caller.signal })
      .catch((e: unknown) => e);
    caller.abort();
    // A room that ended mid-answer did not time out, and is not reported as if it had.
    expect(decisionErrorCode(await pending)).toBe('DECISION_ABORTED');
  });

  it('refuses a non-2xx answer with the status, and keeps the body out of the error', async () => {
    // A gateway validation error can quote the request back, and the request
    // carries the learner's own words: the thrown error goes to Sentry, so it
    // says the status and nothing else.
    const { fetch } = stub(() =>
      json({ error: { message: 'received: why divide by sqrt d' } }, 400),
    );
    const error = await model(fetch)
      .decide(request)
      .catch((e: unknown) => e);
    expect(decisionErrorCode(error)).toBe('DECISION_HTTP_400');
    expect(String(error)).not.toContain('sqrt d');
    expect(String(error)).toBe('Error: DECISION_HTTP_400');
  });

  it('hands the refusal body only to a caller that asked for it', async () => {
    const seen: Array<[number, string]> = [];
    const jev = new JevDecisionsModel({
      apiKey: 'test-key',
      model: 'typesafe/jev-1.13',
      timeoutMs: 600,
      fetch: stub(() => json({ error: { message: 'No matching discriminator' } }, 400)).fetch,
      onRefusal: (status, body) => seen.push([status, body]),
    });
    await jev.decide(request).catch(() => undefined);
    expect(seen[0]?.[0]).toBe(400);
    expect(seen[0]?.[1]).toContain('No matching discriminator');
  });

  it('calls a timeout during the body a timeout, not a changed shape', async () => {
    // DECISION_MALFORMED is the code that means "the gateway changed shape" —
    // the one worth alerting on. A budget that fires while the body is still
    // streaming leaves an unparseable half-response, and must not raise it.
    // The stream aborts with the signal, the way undici's does.
    const { fetch } = stub(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ans'));
              init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const error = await model(fetch, 30)
      .decide(request)
      .catch((e: unknown) => e);
    expect(decisionErrorCode(error)).toBe('DECISION_TIMEOUT');
  });

  it('refuses a 200 whose shape it does not recognise', async () => {
    const { fetch } = stub(() => json({ answers: { intent: { choice: 'command' } } }));
    const error = await model(fetch)
      .decide(request)
      .catch((e: unknown) => e);
    // No `confidence`: the one field the fallback rule depends on.
    expect(decisionErrorCode(error)).toBe('DECISION_MALFORMED');
  });

  it('reports an unreachable gateway as its own code, not a timeout', async () => {
    const { fetch } = stub(() => Promise.reject(new Error('ECONNREFUSED')));
    const error = await model(fetch)
      .decide(request)
      .catch((e: unknown) => e);
    expect(decisionErrorCode(error)).toBe('DECISION_UNREACHABLE');
  });
});
