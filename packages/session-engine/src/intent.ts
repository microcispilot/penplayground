import type { Meta, TelemetryPort } from '@pen/contracts';
import { intentCostLines } from '@pen/contracts';
import type { DecisionsModel, LanguageModel } from '@pen/llm';
import { decisionErrorCode } from '@pen/llm';
import { intentMessages } from './prompts.js';
import { IntentOutput } from './schemas.js';

/**
 * Who decides what a learner utterance *is*, once `classifyLocally` has
 * declined (`brain.ts`). The heuristics stay in front and still cost nothing;
 * this is only the path they fall through to.
 *
 * Two implementations, chosen by `PEN_INTENT_PROVIDER`:
 *
 *   model   the composing model, one structured-output call — what this has
 *           always been, and still the fallback under everything below.
 *   jev     a hosted decisions model, which answers in a fraction of the time
 *           and, unlike a schema-constrained completion, says how sure it is.
 *
 * The confidence is the point of the second one. A completion that must emit
 * one of six enum values always emits one, with no way to tell a read
 * utterance from a coin flip; a decision comes with a number, so an uncertain
 * one can be handed back to the slower, safer path instead of acted on.
 */
export interface IntentRequest {
  text: string;
  /** Room mode ("teaching", "checking", …), so the same words read differently mid-check. */
  mode: string;
  pendingCheck: boolean;
  signal?: AbortSignal;
}

/** What a classification cost, for classifiers that spend outside the `llm` stage. */
export interface IntentUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  totalMs: number;
}

export interface IntentDecision {
  intent: IntentOutput['intent'];
  command: IntentOutput['command'];
  /**
   * 0–1, or null when the classifier has no opinion about its own certainty
   * (the model path). Null is trusted: it means "not measurable here", not
   * "unsure", and gating on it would disable the fallback it is meant to be.
   */
  confidence: number | null;
  /** Null when the call is already priced elsewhere (the model path is an `llm` stage). */
  usage: IntentUsage | null;
}

export interface IntentClassifier {
  readonly id: string;
  classify(request: IntentRequest): Promise<IntentDecision>;
}

/** Ledger tag for every intent call, whichever provider makes it. */
export const INTENT_PURPOSE = 'intent';
/** Two enum values and nothing else; the schema does the rest. */
export const INTENT_MAX_OUTPUT_TOKENS = 40;

/**
 * Below this, the answer is not acted on — the turn falls through to the
 * model path exactly as if the classifier had not been configured.
 *
 * Measured over 22 live decisions on this taxonomy (2026-09-19,
 * `pnpm --filter @pen/api intent:probe`). Sorted, they fall in two clumps
 * with nothing between them:
 *
 *   0.40  0.52  0.53  0.68  │  0.74 … 1.00  (18 of them)
 *
 * 0.70 sits in that empty band. Everything it rejects is something worth
 * rejecting: "okay I'm going to stop here for today" (`end`, 0.53), "give me
 * a second, someone is at the door" (`pause`, 0.52), an `end` the classifier
 * would not commit to (0.40) — and one ordinary question at 0.68 that only
 * pays an extra model call for the caution.
 *
 * The asymmetry is deliberate and is why the threshold sits at the top of the
 * band rather than the bottom: falling through costs a few hundred
 * milliseconds and one model call, while acting on a misread `end` costs the
 * learner their session. Lowering this to catch the 0.68 case would leave
 * only 0.07 between the threshold and a session-ending command. If the band
 * closes, this moves up, not down.
 */
export const INTENT_MIN_CONFIDENCE = 0.7;

/**
 * Hard budget for a hosted classification. Measured over 74 live calls
 * (2026-09-19), which split cleanly in two:
 *
 *   warm connection   128–390 ms, p50 ~200 ms  (every call but the first)
 *   first of a process   410–518 ms            (TLS and connection setup)
 *
 * 600 ms clears the slowest warm call by 1.5×, which is what matters: the API
 * is a long-lived process and keeps the connection, so every classification
 * after the first is a warm one. A cold start that does trip the budget falls
 * back to a correct answer once and is warm from then on — the right thing to
 * lose, and cheaper than carrying a looser budget on every turn after it.
 *
 * Past this the call has already lost its race against the model fallback it
 * exists to beat, and waiting longer only delays that fallback. The worst case
 * — timeout plus a full model call — still lands inside the two-second silence
 * bar, though without much room (see ADR-0024).
 */
export const INTENT_TIMEOUT_MS = 600;

/** The taxonomy, as `IntentOutput` defines it, written for a decisions model. */
export const INTENT_CRITERIA: Record<IntentOutput['intent'], string> = {
  question: 'The learner asks something about the topic being taught.',
  clarify: 'The learner asks the teacher to repeat or explain the last thing again.',
  backchannel:
    'A short listening noise that is not a turn at all (mm-hmm, okay, right, got it, go on).',
  command:
    'The learner is directing the lesson itself rather than talking about the topic: pause, resume, repeat, next, slower, end.',
  answer: 'The learner is answering the check-in question the teacher just asked.',
  off_topic: 'The utterance has nothing to do with the lesson.',
};

/**
 * `none` is spelled out rather than left implicit. Asked without it, the model
 * answers this question on its own terms and reads "sorry, what did you just
 * say?" as `repeat` — true of the words, wrong for a turn whose intent is
 * `clarify`. With the criterion below, the same utterance came back `none`.
 */
export const INTENT_COMMAND_CRITERIA: Record<IntentOutput['command'], string> = {
  none: 'Not a command at all — the utterance is a question, a clarification, an answer, a backchannel, or off topic. Choose this unless the learner is directing the lesson itself.',
  pause: 'Stop the lesson for now and wait.',
  resume: 'Carry on with the lesson from where it stopped.',
  repeat: 'Say the previous sentence again.',
  next: 'Skip ahead to the next part of the lesson.',
  slower: 'Teach at a slower pace.',
  end: 'Finish the session entirely.',
};

/**
 * The situation handed to the decisions model. Prose, because that is what
 * the endpoint takes — and the learner's words are the last line of it, the
 * same discipline the prompt-cache prefixes follow elsewhere.
 */
export function intentState(request: IntentRequest): string {
  const check = request.pendingCheck
    ? ' The teacher has just asked a check-in question and is waiting for the answer.'
    : '';
  return `A learner is in a live one-to-one voice lesson with an AI teacher. The room is in "${request.mode}" mode.${check}\nThe learner just said: "${request.text}"`;
}

/**
 * What this has always been: one structured-output call on the session's own
 * model, under the session's prompt-cache key. It is both a provider in its
 * own right (`PEN_INTENT_PROVIDER=model`) and the floor every other provider
 * falls back to — including `jev`, which is the default since ADR-0025.
 */
export class ModelIntentClassifier implements IntentClassifier {
  readonly id: string;

  constructor(private readonly o: { model: LanguageModel; cacheKey: string }) {
    this.id = `model:${o.model.id}`;
  }

  async classify(request: IntentRequest): Promise<IntentDecision> {
    const { value } = await this.o.model.complete({
      messages: intentMessages({
        text: request.text,
        mode: request.mode,
        pendingCheck: request.pendingCheck,
      }),
      schema: IntentOutput,
      schemaName: 'intent',
      cacheKey: this.o.cacheKey,
      maxOutputTokens: INTENT_MAX_OUTPUT_TOKENS,
      purpose: INTENT_PURPOSE,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    // The call is already one priced `llm` stage; nothing to price twice.
    return { intent: value.intent, command: value.command, confidence: null, usage: null };
  }
}

/** Question names on the wire; both come back in one round trip. */
const Q_INTENT = 'intent';
const Q_COMMAND = 'command';

/**
 * The hosted classifier. Both questions go in one request on purpose: a
 * second round trip would double the hot-path cost for exactly the utterances
 * most likely to be commands, and the one failure it would have prevented —
 * a command read off an utterance that is not one — is prevented here by
 * construction instead, because the command answer is only read when the
 * intent answer says `command`.
 */
export class JevIntentClassifier implements IntentClassifier {
  readonly id: string;

  constructor(private readonly o: { decisions: DecisionsModel }) {
    this.id = o.decisions.id;
  }

  async classify(request: IntentRequest): Promise<IntentDecision> {
    const { answers, usage } = await this.o.decisions.decide({
      state: intentState(request),
      // The house ledger buckets by purpose across the whole process, and the
      // model path already spends under `intent` there at a different price
      // per token. Kept apart so the two are never summed as one number; the
      // session's own cost line stays `component: 'intent'`.
      purpose: `${INTENT_PURPOSE}:jev`,
      questions: {
        [Q_INTENT]: {
          instructions: 'What is the learner doing with this utterance?',
          criteria: INTENT_CRITERIA,
        },
        [Q_COMMAND]: {
          instructions:
            'If and only if the learner is directing the lesson itself, which command is it? Otherwise answer none.',
          criteria: INTENT_COMMAND_CRITERIA,
        },
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const intentAnswer = answers[Q_INTENT];
    if (!intentAnswer) throw new Error('DECISION_MISSING_ANSWER: intent');
    const intent = IntentOutput.shape.intent.safeParse(intentAnswer.choice);
    // Trimmed: this becomes a Sentry exception title, and the provider's
    // string is only bounded by the wire.
    if (!intent.success)
      throw new Error(`DECISION_UNKNOWN_CHOICE: intent=${intentAnswer.choice.slice(0, 40)}`);

    // Anything that is not a command has no command, whatever the second
    // question answered; only a command turn may move the session.
    let command: IntentOutput['command'] = 'none';
    let confidence = intentAnswer.confidence;
    if (intent.data === 'command') {
      const commandAnswer = answers[Q_COMMAND];
      if (!commandAnswer) throw new Error('DECISION_MISSING_ANSWER: command');
      const parsed = IntentOutput.shape.command.safeParse(commandAnswer.choice);
      if (!parsed.success)
        throw new Error(`DECISION_UNKNOWN_CHOICE: command=${commandAnswer.choice.slice(0, 40)}`);
      command = parsed.data;
      // A command is the one answer that changes the session rather than
      // describing it, so it is only as trustworthy as its weaker half: "I am
      // certain this is a command, and unsure whether it means pause or end"
      // must not pause, and must not end.
      confidence = Math.min(confidence, commandAnswer.confidence);
    }
    return {
      intent: intent.data,
      command,
      confidence,
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
 * Wraps a classifier so every hosted call becomes one `intent` stage sample
 * and one `intent` cost line on the session's telemetry port — the same deal
 * `withTelemetry` gives a model call, so Insights and PostHog see this spend
 * beside every other provider's.
 *
 * A classifier that reports no usage records nothing: the model path's call is
 * already an `llm` stage with `purpose: "intent"`, and counting it twice would
 * make a session look like it classified everything twice over.
 */
export function withIntentTelemetry(
  classifier: IntentClassifier,
  telemetry: TelemetryPort,
): IntentClassifier {
  return {
    id: classifier.id,
    async classify(request: IntentRequest): Promise<IntentDecision> {
      const startedAt = Date.now();
      try {
        const decision = await classifier.classify(request);
        const { usage } = decision;
        if (usage) {
          const meta: Meta = {
            purpose: INTENT_PURPOSE,
            model: usage.model,
            intent: decision.intent,
            command: decision.command,
            confidence: decision.confidence ?? -1,
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            usd: usage.usd,
            reused: false,
          };
          telemetry.sample({ stage: 'intent', ms: usage.totalMs, ok: true, startedAt, meta });
          for (const line of intentCostLines(usage, { purpose: INTENT_PURPOSE }))
            telemetry.cost(line);
        }
        return decision;
      } catch (error) {
        // A session that ended mid-answer is not a provider that failed, and
        // recording it would put a failed stage in the Insights of every
        // session that closes on a turn.
        if (request.signal?.aborted) throw error;
        telemetry.sample({
          stage: 'intent',
          ms: Date.now() - startedAt,
          ok: false,
          startedAt,
          meta: {
            purpose: INTENT_PURPOSE,
            model: classifier.id,
            code: decisionErrorCode(error),
          },
        });
        throw error;
      }
    },
  };
}
