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

/** USD per 1M tokens: input, cached input, output (OpenAI pricing page, 2026-09-16). */
export const PRICING: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },
  'gemini-2.5-flash-lite': { input: 0.1, cached: 0.01, output: 0.4 },
};

export function priceUsd(model: string, input: number, cached: number, output: number): number {
  const p = PRICING[model] ?? PRICING['gpt-5.6-luna'];
  if (!p) return 0;
  return ((input - cached) * p.input + cached * p.cached + output * p.output) / 1_000_000;
}
