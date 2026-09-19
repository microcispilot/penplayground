import { intentUsd } from '@pen/contracts';
import { z } from 'zod';
import { type CostMeter, NOOP_METER } from './types.js';

/**
 * OpenRouter's decisions endpoint (`POST /api/alpha/decisions`).
 *
 * A decisions model is not a chat model: it is asked named multiple-choice
 * questions about a described situation and answers each one with a choice, a
 * probability distribution over the options and a confidence. Asking for
 * `typesafe/jev-1.13` on `/chat/completions` is refused by the gateway
 * ("is a decisions model and cannot be used with the chat/completions
 * endpoint"), and the model does not appear in `GET /api/v1/models` at all, so
 * this adapter speaks the decisions wire directly rather than going through
 * the OpenAI SDK like `OpenAILanguageModel`.
 *
 * The package owns the protocol — auth, budget, validation, pricing — and
 * nothing about what the questions mean. The session engine owns the taxonomy
 * and the mapping back into its own schema (`intent.ts`).
 */

/**
 * One multiple-choice question. Two fields the endpoint will not do without,
 * both learned from its 400s: `criteria` ("expected record, received
 * undefined") and the `type` discriminator ("No matching discriminator") that
 * this adapter stamps on for you — `choice` is the only kind it asks.
 */
export interface DecisionQuestion {
  /** What the model is being asked to decide. */
  instructions: string;
  /** Every allowed option → what choosing it means. The answer is one of these keys. */
  criteria: Record<string, string>;
}

export interface DecisionAnswer {
  /** One of the question's `criteria` keys. */
  choice: string;
  /** 0–1, the model's own certainty in this answer. */
  confidence: number;
  /** The full distribution over the question's options. */
  probabilities: Record<string, number>;
}

/** Priced like every other provider call (`intentCostLines` in contracts). */
export interface DecisionUsage {
  model: string;
  inputTokens: number;
  /** Reported, and free on Jev; kept so a price change is visible rather than silent. */
  outputTokens: number;
  usd: number;
  /** What the provider itself said the call cost, when it said so — a cross-check on our table. */
  reportedUsd: number | null;
  totalMs: number;
}

export interface DecisionRequest {
  /** The situation, as prose. */
  state: string;
  /** Question name → question. Every name comes back in `answers`. */
  questions: Record<string, DecisionQuestion>;
  /** Free-form tag for the cost ledger ("intent"). */
  purpose: string;
  signal?: AbortSignal;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
}

/** The seam: one situation in, one answer per question out. */
export interface DecisionsModel {
  readonly id: string;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

/**
 * The wire response, validated before anything is read off it. A gateway that
 * answers 200 with a shape we do not recognise is a failure, not a decision.
 */
const DecisionsResponse = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.object({
      choice: z.string().min(1),
      confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number()).default({}),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().default(0),
      output_tokens: z.number().nonnegative().default(0),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
  provider: z.string().optional(),
});

export interface JevDecisionsOptions {
  apiKey: string;
  /**
   * Pinned on purpose. `typesafe/jev-latest` exists in TypeSafe's own console
   * but OpenRouter rejects that id; `typesafe/jev-1.13` is the one that works.
   */
  model: string;
  baseUrl?: string;
  /**
   * Hard budget for the round trip. This runs between the learner's last word
   * and the first sound back, so a slow call is worth less than the fallback
   * it is racing: past this the caller gives up and takes the model path.
   */
  timeoutMs: number;
  /** The house cost ledger, as every other provider adapter reports to it. */
  meter?: CostMeter;
  /**
   * A refused request's status and raw body, for a caller that can be trusted
   * with it. Deliberately opt-in: the body may quote our request back, and
   * our request carries what the learner said. Wired up by the probe, never
   * in a session.
   */
  onRefusal?: (status: number, body: string) => void;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export const JEV_DEFAULT_BASE_URL = 'https://openrouter.ai/api/alpha/decisions';

export class JevDecisionsModel implements DecisionsModel {
  readonly id: string;
  private readonly meter: CostMeter;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(private readonly opts: JevDecisionsOptions) {
    this.id = opts.model;
    this.meter = opts.meter ?? NOOP_METER;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = performance.now();
    const budget = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = request.signal ? AbortSignal.any([budget, request.signal]) : budget;
    let response: Response;
    try {
      response = await this.doFetch(this.opts.baseUrl ?? JEV_DEFAULT_BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.opts.model,
          state: request.state,
          questions: Object.fromEntries(
            Object.entries(request.questions).map(([name, q]) => [name, { type: 'choice', ...q }]),
          ),
        }),
        signal,
      });
    } catch (error) {
      // The caller's own signal comes first: a room that ended mid-answer did
      // not time out, and must not be reported as though it had.
      if (request.signal?.aborted) throw new Error('DECISION_ABORTED: the caller gave up');
      if (budget.aborted)
        throw new Error(`DECISION_TIMEOUT: no answer in ${this.opts.timeoutMs} ms`);
      throw new Error(`DECISION_UNREACHABLE: ${message(error)}`);
    }
    if (!response.ok) {
      // The status is the whole of the message, on purpose. Thrown errors
      // reach Sentry, and a validation error from the gateway may quote the
      // request that caused it — and our request carries the learner's own
      // words. A refusal is a configuration problem, not a per-utterance one,
      // so the body goes only to a caller that explicitly asked for it (the
      // probe, run by a human against their own sentences) and nowhere else.
      if (this.opts.onRefusal) {
        const body = await response.text().catch(() => '');
        try {
          this.opts.onRefusal(response.status, body);
        } catch {
          /* a diagnostic hook never breaks the call it is diagnosing */
        }
      }
      throw new Error(`DECISION_HTTP_${response.status}`);
    }
    const parsed = DecisionsResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      // The budget covers the body too, and an abort there leaves a half-read
      // stream that fails to parse. `DECISION_MALFORMED` is the code that
      // means "the gateway changed shape" — the one worth alerting on — so a
      // slow network must not be able to raise it.
      if (request.signal?.aborted) throw new Error('DECISION_ABORTED: the caller gave up');
      if (budget.aborted)
        throw new Error(`DECISION_TIMEOUT: no answer in ${this.opts.timeoutMs} ms`);
      throw new Error(`DECISION_MALFORMED: ${parsed.error.issues[0]?.message ?? 'bad shape'}`);
    }
    const body = parsed.data;
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    const model = body.model ?? this.opts.model;
    const usage: DecisionUsage = {
      model,
      inputTokens,
      outputTokens,
      usd: intentUsd(model, inputTokens),
      reportedUsd: body.usage?.cost ?? null,
      totalMs: Math.round(performance.now() - started),
    };
    this.meter.record({
      model,
      inputTokens,
      // There is no prompt cache on this endpoint, and output is not billed.
      cachedTokens: 0,
      outputTokens,
      usd: usage.usd,
      firstTokenMs: null,
      totalMs: usage.totalMs,
      purpose: request.purpose,
    });
    return { answers: body.answers, usage };
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
