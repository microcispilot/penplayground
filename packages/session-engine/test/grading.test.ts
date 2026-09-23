import type { CostLine, StageSample } from '@pen/contracts';
import type { DecisionRequest, DecisionResult, DecisionsModel } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import { checkFeedback } from '../src/brain.js';
import {
  GRADE_CRITERIA,
  GRADE_MIN_CONFIDENCE,
  gradeState,
  JevGrader,
  withGradeTelemetry,
} from '../src/grading.js';

/** A decisions model that answers what it is told to and remembers what it was asked. */
class ScriptedDecisions implements DecisionsModel {
  readonly id = 'jev-latest';
  readonly requests: DecisionRequest[] = [];
  constructor(private readonly answer: () => DecisionResult) {}
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request);
    return this.answer();
  }
}

const usage = {
  model: 'jev-1.13.0',
  inputTokens: 398,
  outputTokens: 20,
  usd: 0.0000167,
  reportedUsd: null,
  totalMs: 276,
};
const verdict = (choice: string, confidence: number): DecisionResult => ({
  answers: { verdict: { choice, confidence, probabilities: { [choice]: confidence } } },
  usage,
});

const request = {
  question: 'Quick one: what is a vector here?',
  expected: 'A list of numbers',
  options: ['A word', 'A list of numbers', 'A position'],
  answer: 'a list of numbers',
  explain: 'A vector is just a list of numbers.',
};

describe('gradeState', () => {
  it('puts the question, the options, the reference and the learner’s words in the situation, learner last', () => {
    const state = gradeState(request);
    expect(state).toContain('"Quick one: what is a vector here?"');
    expect(state).toContain('A word | A list of numbers | A position');
    expect(state).toContain('"A list of numbers"');
    expect(state.trimEnd().endsWith('The learner answered: "a list of numbers"')).toBe(true);
  });

  it('leaves the options line out of a free-answer check', () => {
    expect(gradeState({ ...request, options: [] })).not.toContain('options offered');
  });
});

describe('JevGrader', () => {
  it('asks one choice question over the three verdicts and maps the answer back', async () => {
    const decisions = new ScriptedDecisions(() => verdict('correct', 0.93));
    const grader = new JevGrader({ decisions });
    const decision = await grader.grade(request);
    expect(decision).toEqual({
      verdict: 'correct',
      confidence: 0.93,
      usage: {
        model: 'jev-1.13.0',
        inputTokens: 398,
        outputTokens: 20,
        usd: 0.0000167,
        totalMs: 276,
      },
    });
    const asked = decisions.requests[0];
    expect(asked?.purpose).toBe('grade:jev');
    expect(Object.keys(asked?.questions ?? {})).toEqual(['verdict']);
    expect(asked?.questions.verdict?.criteria).toEqual(GRADE_CRITERIA);
  });

  it('refuses a choice outside the taxonomy rather than inventing a verdict', async () => {
    const grader = new JevGrader({
      decisions: new ScriptedDecisions(() => verdict('brilliant', 0.99)),
    });
    await expect(grader.grade(request)).rejects.toThrow(
      /DECISION_UNKNOWN_CHOICE: verdict=brilliant/,
    );
  });

  it('records one intent stage and one intent cost line per hosted grade, tagged grade', async () => {
    const samples: StageSample[] = [];
    const costs: CostLine[] = [];
    const grader = withGradeTelemetry(
      new JevGrader({ decisions: new ScriptedDecisions(() => verdict('partial', 0.81)) }),
      {
        sample: (s) => {
          samples.push({ stage: s.stage, t: 0, ms: s.ms, ok: s.ok, meta: s.meta ?? {} });
        },
        cost: (c) => {
          costs.push(c);
        },
        error: () => undefined,
      },
    );
    await grader.grade(request);
    expect(samples).toEqual([
      {
        stage: 'intent',
        t: 0,
        ms: 276,
        ok: true,
        meta: expect.objectContaining({ purpose: 'grade', verdict: 'partial', confidence: 0.81 }),
      },
    ]);
    expect(costs).toEqual([
      expect.objectContaining({
        component: 'intent',
        unit: 'tokens_in',
        units: 398,
        meta: expect.objectContaining({ purpose: 'grade' }),
      }),
    ]);
  });

  it('records a failed stage with the error code when the call fails', async () => {
    const samples: StageSample[] = [];
    const grader = withGradeTelemetry(
      new JevGrader({
        decisions: new ScriptedDecisions(() => {
          throw new Error('DECISION_TIMEOUT: no answer in 600 ms');
        }),
      }),
      {
        sample: (s) => {
          samples.push({ stage: s.stage, t: 0, ms: s.ms, ok: s.ok, meta: s.meta ?? {} });
        },
        cost: () => undefined,
        error: () => undefined,
      },
    );
    await expect(grader.grade(request)).rejects.toThrow(/DECISION_TIMEOUT/);
    expect(samples[0]).toMatchObject({
      stage: 'intent',
      ok: false,
      meta: { purpose: 'grade', code: 'DECISION_TIMEOUT' },
    });
  });

  it('gates at the same floor intent does', () => {
    expect(GRADE_MIN_CONFIDENCE).toBe(0.7);
  });
});

describe('checkFeedback', () => {
  it('is the verdict, the lesson’s own explanation, and on we go', () => {
    expect(checkFeedback('correct', 'A vector is just a list of numbers.', 0, 'en')).toBe(
      'That’s it. A vector is just a list of numbers. Let’s keep going.',
    );
    expect(checkFeedback('incorrect', 'A vector is just a list of numbers.', 1, 'en-US')).toBe(
      'Not this time. A vector is just a list of numbers. Moving on.',
    );
  });

  it('speaks the lesson’s language, and says nothing for one it has no words in', () => {
    expect(checkFeedback('partial', 'Un vector es una lista de números.', 0, 'es')).toMatch(
      /^Casi/,
    );
    expect(checkFeedback('correct', 'x', 0, 'sw')).toBeNull();
  });

  it('never repeats the explanation and never leaves a double space', () => {
    for (const lang of [
      'en',
      'es',
      'fr',
      'de',
      'it',
      'pt',
      'nl',
      'tr',
      'ru',
      'fa',
      'ar',
      'hi',
      'ja',
      'ko',
      'zh',
    ])
      for (const v of ['correct', 'partial', 'incorrect'] as const)
        for (let seed = 0; seed < 3; seed += 1) {
          const line = checkFeedback(v, 'Because.', seed, lang);
          expect(line, `${lang} ${v}`).not.toBeNull();
          expect(line).not.toMatch(/ {2}/);
          expect(line?.split('Because.').length).toBe(2);
        }
  });
});
