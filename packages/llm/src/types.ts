import type { LessonEvent } from '@pen/contracts';
import type { ZodType } from 'zod';

export type Role = 'system' | 'user' | 'assistant';
export interface Message {
  role: Role;
  content: string;
}

export interface Usage {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  usd: number;
  /** Time to first emitted event (streaming) or completion, ms. */
  firstTokenMs: number | null;
  totalMs: number;
}

export interface EventStreamRequest {
  /** Stable prefix first (persona, rules); the question and Onten context last (prompt-cache discipline). */
  messages: Message[];
  /** Groups requests that share a prefix so the provider caches it. */
  cacheKey: string;
  /** Upper bound on output tokens; the lesson planner uses a larger one than a turn. */
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** Free-form tag for the cost ledger ("lesson", "turn", "grade"). */
  purpose: string;
}

export interface EventStream extends AsyncIterable<LessonEvent> {
  /** Resolves after the stream ends (or aborts) with the measured usage. */
  usage: Promise<Usage>;
  abort(): void;
}

/**
 * Early access to parts of a structured output while the rest is still being
 * written. A completion is one object, but its fields land in order, and a
 * caller that only needs the first of them should not wait for the last: the
 * lesson planner starts teaching segment 1 as soon as segment 1 exists,
 * seconds before the outline is finished.
 *
 * The values handed over are complete and final — each one is emitted when its
 * own closing token lands, never half-parsed — so nothing built on them can be
 * contradicted by the object that arrives afterwards.
 */
export interface PartialValues {
  /**
   * Which values to hand over early, as the subset of JSONPath the incremental
   * parser understands: `$.title` for a field, `$.segments.*` for each element
   * of an array.
   */
  paths: string[];
  /** One matched value. `key` is the property name, or the index within an array. */
  onValue: (key: string | number | undefined, value: unknown) => void;
}

export interface CompletionRequest<T> {
  messages: Message[];
  schema: ZodType<T>;
  schemaName: string;
  cacheKey: string;
  maxOutputTokens: number;
  purpose: string;
  signal?: AbortSignal;
  /**
   * Hand parts of the answer over as they are written. Present = the call is
   * streamed (and `usage.firstTokenMs` is measured); absent = one request, one
   * parsed answer, exactly as before.
   */
  partial?: PartialValues;
}

export interface LanguageModel {
  readonly id: string;
  streamEvents(request: EventStreamRequest): EventStream;
  complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: Usage }>;
}

export interface CostMeter {
  record(usage: Usage & { purpose: string }): void;
}

export const NOOP_METER: CostMeter = { record: () => undefined };

/** Prices live in @pen/contracts (`pricing.ts`) so every cost line shares one table; re-exported for this package's callers. */
export { LLM_PRICING as PRICING, priceUsd } from '@pen/contracts';
