import type { Meta, TelemetryPort } from '@pen/contracts';
import { intentCostLines } from '@pen/contracts';
import type { DecisionsModel } from '@pen/llm';
import { decisionErrorCode } from '@pen/llm';
import type { IntentUsage } from './intent.js';
import type { GradeOutput } from './schemas.js';

/**
 * Who decides whether a check-in answer was right (ADR-0039).
 *
 * Grading is a *decision*, not a composition: the question, the reference
 * answer and the explanation were all written when the lesson was — the
 * check-in cue carries them — and the only new thing is a verdict over the
 * learner's words. Until now that verdict came from the session model in
 * the same call that wrote a sentence of feedback: one structured-output
 * completion, ~1 s to its first token, sitting between the learner's answer
 * and the expert's reply.
 *
 * A decisions model answers the verdict in a fraction of the time, says how
 * sure it is, and costs a thousandth as much; the feedback is then a line
 * the expert already had (`checkFeedback` in `brain.ts`) around the
 * explanation the lesson already wrote. The model path stays underneath as
 * the floor: no grader configured, an answer the grader is not sure of, a
 * language without native feedback lines, a timeout — every one of these
 * falls through to exactly the call this used to be.
 */
export interface GradeRequest {
  question: string;
  expected: string;
  options: string[];
  /** The learner's own words: content, and handled as such — never logged, never a tag. */
  answer: string;
  explain: string;
  signal?: AbortSignal;
}

export interface GradeDecision {
  verdict: GradeOutput['verdict'];
  /** 0–1 from a decisions model; null when the grader has no opinion of its own certainty. */
  confidence: number | null;
  /** Null when the call is already priced elsewhere. */
  usage: IntentUsage | null;
}

export interface Grader {
  readonly id: string;
  grade(request: GradeRequest): Promise<GradeDecision>;
}

/** Ledger tag for a hosted grade; the model path keeps its own `llm` stage with the same purpose. */
export const GRADE_PURPOSE = 'grade';

/**
 * Below this the verdict is not acted on and the model grades instead. The
 * same floor `INTENT_MIN_CONFIDENCE` sits on, for the same reason: the two
 * outcomes are not symmetric. Falling through costs the model call this
 * always used to make; acting on a misread verdict tells a learner they were
 * right when they were not. `pnpm --filter @pen/api grade:probe` measures
 * where the answers actually land; move this up, never down, if the band
 * closes.
 */
export const GRADE_MIN_CONFIDENCE = 0.7;

/** The three verdicts `GradeOutput` allows, written for a decisions model. */
export const GRADE_CRITERIA: Record<GradeOutput['verdict'], string> = {
  correct:
    'The learner’s answer says the same thing as the reference answer, in their own words or by naming the right option. Extra detail or a different wording does not matter.',
  partial:
    'The learner has part of it — the right idea with a piece missing, a mix of a right and a wrong element, or a vague answer that points the right way without committing.',
  incorrect:
    'The learner’s answer disagrees with the reference answer, names a wrong option, answers a different question, or says they do not know.',
};

/**
 * The situation handed to the decisions model. The learner's words are the
 * last line, the same discipline the intent state and the prompt-cache
 * prefixes follow.
 */
export function gradeState(request: GradeRequest): string {
  const options = request.options.length
    ? `\nThe options offered were: ${request.options.join(' | ')}`
    : '';
  return `An AI teacher in a live voice lesson asked a learner a check-in question and is grading the answer.\nThe question: "${request.question}"${options}\nThe reference answer: "${request.expected}"\nWhy that is the answer: ${request.explain}\nThe learner answered: "${request.answer}"`;
}

const Q_VERDICT = 'verdict';

/** The hosted grader: one choice question, one round trip, a confidence to gate on. */
export class JevGrader implements Grader {
  readonly id: string;

  constructor(private readonly o: { decisions: DecisionsModel }) {
    this.id = o.decisions.id;
  }

  async grade(request: GradeRequest): Promise<GradeDecision> {
    const { answers, usage } = await this.o.decisions.decide({
      state: gradeState(request),
      // Kept apart from the model path's `grade` in the house ledger, as
      // `intent:jev` is from `intent`: a different price per token that must
      // never be summed as one number.
      purpose: `${GRADE_PURPOSE}:jev`,
      questions: {
        [Q_VERDICT]: {
          instructions: 'How should the learner’s answer be graded against the reference answer?',
          criteria: GRADE_CRITERIA,
        },
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const answer = answers[Q_VERDICT];
    if (!answer) throw new Error('DECISION_MISSING_ANSWER: verdict');
    const verdict = (Object.keys(GRADE_CRITERIA) as GradeOutput['verdict'][]).find(
      (v) => v === answer.choice,
    );
    // Trimmed: this becomes a Sentry exception title.
    if (!verdict) throw new Error(`DECISION_UNKNOWN_CHOICE: verdict=${answer.choice.slice(0, 40)}`);
    return {
      verdict,
      confidence: answer.confidence,
      usage: {
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usd: usage.usd,
        totalMs: usage.totalMs,
      },
    };
  }
}

/**
 * Every hosted grade becomes one `intent` stage sample and one `intent` cost
 * line with `purpose: grade` — the decisions model is the provider that is
 * being priced, whatever question it answered — so Insights and PostHog see
 * this spend beside the model's own `grade` calls and never confuse the two.
 */
export function withGradeTelemetry(grader: Grader, telemetry: TelemetryPort): Grader {
  return {
    id: grader.id,
    async grade(request: GradeRequest): Promise<GradeDecision> {
      const startedAt = Date.now();
      try {
        const decision = await grader.grade(request);
        const { usage } = decision;
        if (usage) {
          const meta: Meta = {
            purpose: GRADE_PURPOSE,
            model: usage.model,
            verdict: decision.verdict,
            confidence: decision.confidence ?? -1,
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            usd: usage.usd,
            reused: false,
          };
          telemetry.sample({ stage: 'intent', ms: usage.totalMs, ok: true, startedAt, meta });
          for (const line of intentCostLines(usage, { purpose: GRADE_PURPOSE }))
            telemetry.cost(line);
        }
        return decision;
      } catch (error) {
        // A session that ended mid-grade is not a provider that failed.
        if (request.signal?.aborted) throw error;
        telemetry.sample({
          stage: 'intent',
          ms: Date.now() - startedAt,
          ok: false,
          startedAt,
          meta: { purpose: GRADE_PURPOSE, model: grader.id, code: decisionErrorCode(error) },
        });
        throw error;
      }
    },
  };
}
