import type { CostLine, StageSample } from '@pen/contracts';
import type { DecisionRequest, DecisionResult, DecisionsModel } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import {
  INTENT_CRITERIA,
  INTENT_MIN_CONFIDENCE,
  intentState,
  JevIntentClassifier,
  withIntentTelemetry,
} from '../src/intent.js';
import { SessionMetrics } from '../src/metrics.js';

type Answer = { choice: string; confidence: number };

/** A decisions model that answers from a script and records what it was asked. */
class ScriptedDecisions implements DecisionsModel {
  readonly id = 'typesafe/jev-1.13';
  readonly requests: DecisionRequest[] = [];
  constructor(private readonly answers: Record<string, Answer>) {}
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request);
    return {
      answers: Object.fromEntries(
        Object.entries(this.answers).map(([k, a]) => [k, { ...a, probabilities: {} }]),
      ),
      usage: {
        model: 'typesafe/jev-1.13',
        inputTokens: 685,
        outputTokens: 128,
        usd: 0.00002877,
        reportedUsd: 0.00002877,
        totalMs: 211,
      },
    };
  }
}

const ask = (decisions: DecisionsModel, text = 'anything') =>
  new JevIntentClassifier({ decisions }).classify({ text, mode: 'teaching', pendingCheck: false });

describe('intentState', () => {
  it('names the mode, the pending check and the learner utterance, and nothing else', () => {
    const state = intentState({ text: 'is it linear?', mode: 'checking', pendingCheck: true });
    expect(state).toContain('"checking"');
    expect(state).toContain('waiting for the answer');
    // The words the learner said are the last line, after the situation.
    expect(state.trimEnd().endsWith('"is it linear?"')).toBe(true);
    expect(intentState({ text: 'x', mode: 'teaching', pendingCheck: false })).not.toContain(
      'check-in',
    );
  });
});

describe('JevIntentClassifier', () => {
  it('asks both questions in one round trip, each with its criteria', async () => {
    const decisions = new ScriptedDecisions({
      intent: { choice: 'question', confidence: 0.98 },
      command: { choice: 'none', confidence: 0.9 },
    });
    await ask(decisions);
    expect(decisions.requests).toHaveLength(1);
    const questions = decisions.requests[0]?.questions ?? {};
    expect(Object.keys(questions).sort()).toEqual(['command', 'intent']);
    expect(questions.intent?.criteria).toEqual(INTENT_CRITERIA);
    // "none" must be an option the model can pick, not an absence it infers.
    expect(Object.keys(questions.command?.criteria ?? {})).toContain('none');
    // The house ledger buckets by purpose across the process, so the hosted
    // call is kept out of the model path's `intent` bucket: two token prices.
    expect(decisions.requests[0]?.purpose).toBe('intent:jev');
  });

  it('maps a choice pair onto IntentOutput and reports the confidence', async () => {
    const decision = await ask(
      new ScriptedDecisions({
        intent: { choice: 'command', confidence: 1 },
        command: { choice: 'next', confidence: 0.99 },
      }),
    );
    expect(decision.intent).toBe('command');
    expect(decision.command).toBe('next');
    expect(decision.confidence).toBe(0.99);
    expect(decision.usage).toMatchObject({ inputTokens: 685, usd: 0.00002877, totalMs: 211 });
  });

  it('ignores the command answer unless the intent is a command', async () => {
    // The measured miss: "sorry, what did you just say?" reads as `repeat` to
    // the command question on its own, while the turn is a `clarify`.
    const decision = await ask(
      new ScriptedDecisions({
        intent: { choice: 'clarify', confidence: 1 },
        command: { choice: 'repeat', confidence: 0.69 },
      }),
    );
    expect(decision.intent).toBe('clarify');
    expect(decision.command).toBe('none');
    // …and the command question's own doubt does not drag a sound answer down.
    expect(decision.confidence).toBe(1);
  });

  it('is only as sure of a command as its weaker half', async () => {
    const decision = await ask(
      new ScriptedDecisions({
        intent: { choice: 'command', confidence: 1 },
        command: { choice: 'end', confidence: 0.4 },
      }),
    );
    expect(decision.confidence).toBe(0.4);
    expect(decision.confidence).toBeLessThan(INTENT_MIN_CONFIDENCE);
  });

  it('refuses a choice outside the taxonomy instead of guessing one', async () => {
    await expect(
      ask(new ScriptedDecisions({ intent: { choice: 'smalltalk', confidence: 1 } })),
    ).rejects.toThrow(/DECISION_UNKNOWN_CHOICE/);
    await expect(
      ask(
        new ScriptedDecisions({
          intent: { choice: 'command', confidence: 1 },
          command: { choice: 'rewind', confidence: 1 },
        }),
      ),
    ).rejects.toThrow(/DECISION_UNKNOWN_CHOICE/);
  });

  it('refuses an answer set that is missing the question it asked', async () => {
    await expect(ask(new ScriptedDecisions({}))).rejects.toThrow(/DECISION_MISSING_ANSWER/);
  });
});

describe('withIntentTelemetry', () => {
  function recorder() {
    const samples: StageSample[] = [];
    const costs: CostLine[] = [];
    const metrics = new SessionMetrics({
      sessionId: 's',
      startedAt: Date.now(),
      onSample: (s) => samples.push(s),
      onCost: (c) => costs.push(c),
    });
    return { samples, costs, metrics };
  }

  it('records one intent stage and one intent cost line per hosted call', async () => {
    const { samples, costs, metrics } = recorder();
    const classifier = withIntentTelemetry(
      new JevIntentClassifier({
        decisions: new ScriptedDecisions({
          intent: { choice: 'command', confidence: 0.99 },
          command: { choice: 'slower', confidence: 0.89 },
        }),
      }),
      metrics,
    );
    await classifier.classify({ text: 'too fast', mode: 'teaching', pendingCheck: false });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ stage: 'intent', ms: 211, ok: true });
    expect(samples[0]?.meta).toMatchObject({
      purpose: 'intent',
      model: 'typesafe/jev-1.13',
      intent: 'command',
      command: 'slower',
      confidence: 0.89,
      tokensIn: 685,
    });
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ component: 'intent', unit: 'tokens_in', units: 685 });
    expect(costs[0]?.usd).toBeCloseTo(0.00002877, 12);
  });

  it('records a failed call as a stage with a code, and rethrows it', async () => {
    const { samples, costs, metrics } = recorder();
    const classifier = withIntentTelemetry(
      {
        id: 'typesafe/jev-1.13',
        classify: () => Promise.reject(new Error('DECISION_TIMEOUT: no answer in 600 ms')),
      },
      metrics,
    );
    await expect(
      classifier.classify({ text: 'x', mode: 'teaching', pendingCheck: false }),
    ).rejects.toThrow(/DECISION_TIMEOUT/);
    expect(samples[0]).toMatchObject({ stage: 'intent', ok: false });
    expect(samples[0]?.meta.code).toBe('DECISION_TIMEOUT');
    expect(costs).toHaveLength(0);
  });

  it('prices nothing for a classifier whose call is already an llm stage', async () => {
    const { samples, costs, metrics } = recorder();
    const classifier = withIntentTelemetry(
      {
        id: 'model:fake',
        classify: async () => ({
          intent: 'question' as const,
          command: 'none' as const,
          confidence: null,
          usage: null,
        }),
      },
      metrics,
    );
    await classifier.classify({ text: 'x', mode: 'teaching', pendingCheck: false });
    expect(samples).toHaveLength(0);
    expect(costs).toHaveLength(0);
  });
});
