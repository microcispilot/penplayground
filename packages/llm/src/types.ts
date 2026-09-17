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

export interface CompletionRequest<T> {
  messages: Message[];
  schema: ZodType<T>;
  schemaName: string;
  cacheKey: string;
  maxOutputTokens: number;
  purpose: string;
  signal?: AbortSignal;
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
