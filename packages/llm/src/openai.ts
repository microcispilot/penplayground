import type { LessonEvent } from '@pen/contracts';
import { JSONParser } from '@streamparser/json';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ParsedResponse } from 'openai/resources/responses/responses';
import type { ZodType } from 'zod';
import { LessonEventParser } from './event-parser.js';
import { ModelEnvelope } from './model-schema.js';
import {
  type CompletionRequest,
  type CostMeter,
  type EventStream,
  type EventStreamRequest,
  type LanguageModel,
  NOOP_METER,
  priceUsd,
  type Usage,
} from './types.js';

export interface OpenAIModelOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** 'none' for the composing model (ADR-0008). */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  meter?: CostMeter;
  /** Reported through observability; never throws. */
  onInvalidEvent?: (raw: unknown, error: unknown) => void;
  timeoutMs?: number;
}

/**
 * OpenAI Responses adapter: strict JSON-schema output streamed as raw text
 * deltas, parsed incrementally into validated lesson events.
 */
export class OpenAILanguageModel implements LanguageModel {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly meter: CostMeter;

  constructor(private readonly opts: OpenAIModelOptions) {
    this.id = `openai:${opts.model}`;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 60_000,
      maxRetries: 1,
    });
    this.meter = opts.meter ?? NOOP_METER;
  }

  streamEvents(request: EventStreamRequest): EventStream {
    const started = performance.now();
    let firstTokenMs: number | null = null;
    const queue: LessonEvent[] = [];
    const wake: { fn: (() => void) | null } = { fn: null };
    let finished = false;
    let failure: unknown = null;
    const controller = new AbortController();
    if (request.signal)
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });

    const parser = new LessonEventParser({
      onEvent: (event) => {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
        queue.push(event);
        wake.fn?.();
      },
      onInvalid: (raw, error) => this.opts.onInvalidEvent?.(raw, error),
    });

    const usage = (async (): Promise<Usage> => {
      let u: Usage = {
        model: this.opts.model,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        usd: 0,
        firstTokenMs: null,
        totalMs: 0,
      };
      try {
        const stream = this.client.responses.stream(
          {
            model: this.opts.model,
            input: request.messages.map((m) => ({ role: m.role, content: m.content })),
            reasoning: { effort: this.opts.reasoningEffort ?? 'none' },
            text: { format: zodTextFormat(ModelEnvelope, 'lesson_events'), verbosity: 'low' },
            max_output_tokens: request.maxOutputTokens,
            prompt_cache_key: request.cacheKey,
            store: false,
            ...(this.opts.serviceTier ? { service_tier: this.opts.serviceTier } : {}),
          },
          { signal: controller.signal },
        );
        stream.on('response.output_text.delta', (ev) => parser.write(ev.delta));
        stream.on('response.refusal.done', (ev) => {
          failure = new Error(`LLM_REFUSAL: ${ev.refusal}`);
        });
        const final = await stream.finalResponse();
        parser.end();
        const inputTokens = final.usage?.input_tokens ?? 0;
        const cachedTokens = final.usage?.input_tokens_details?.cached_tokens ?? 0;
        const outputTokens = final.usage?.output_tokens ?? 0;
        u = {
          model: this.opts.model,
          inputTokens,
          cachedTokens,
          outputTokens,
          usd: priceUsd(this.opts.model, inputTokens, cachedTokens, outputTokens),
          firstTokenMs,
          totalMs: Math.round(performance.now() - started),
        };
        if (final.status === 'incomplete')
          failure ??= new Error(`LLM_INCOMPLETE: ${final.incomplete_details?.reason ?? 'unknown'}`);
      } catch (error) {
        if (!controller.signal.aborted) failure = error;
        parser.end();
      } finally {
        finished = true;
        wake.fn?.();
        this.meter.record({ ...u, purpose: request.purpose });
      }
      return u;
    })();

    const iterator: AsyncIterator<LessonEvent> = {
      next: async () => {
        for (;;) {
          const ev = queue.shift();
          if (ev) return { value: ev, done: false };
          if (finished) {
            if (failure && queue.length === 0) throw failure;
            return { value: undefined as never, done: true };
          }
          await new Promise<void>((resolve) => {
            wake.fn = resolve;
          });
          wake.fn = null;
        }
      },
      return: async () => {
        controller.abort();
        return { value: undefined as never, done: true };
      },
    };
    return {
      [Symbol.asyncIterator]: () => iterator,
      usage,
      abort: () => controller.abort(),
    };
  }

  async complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: Usage }> {
    const started = performance.now();
    const body = {
      model: this.opts.model,
      input: request.messages.map((m) => ({ role: m.role, content: m.content })),
      reasoning: { effort: this.opts.reasoningEffort ?? 'none' },
      text: { format: zodTextFormat(request.schema as ZodType, request.schemaName) },
      max_output_tokens: request.maxOutputTokens,
      prompt_cache_key: request.cacheKey,
      store: false,
    } as const;
    // One parser over the raw deltas: each selected value reaches the caller the
    // moment its own closing token lands, while the rest of the object is still
    // being written. Without a `partial` this is one request and one answer,
    // exactly as before.
    const partial = request.partial;
    let firstTokenMs: number | null = null;
    // The answer is validated with Zod below, so the provider's own parse is
    // only ever read as `unknown` — either route returns the same shape.
    let response: ParsedResponse<unknown>;
    if (partial) {
      const parser = new JSONParser({ paths: partial.paths, keepStack: false });
      parser.onValue = ({ key, value }) => partial.onValue(key, value);
      // A malformed tail is the final parse's problem, not this one's: what was
      // already emitted was well-formed JSON and is still good.
      parser.onError = () => undefined;
      const stream = this.client.responses.stream(body, { signal: request.signal });
      stream.on('response.output_text.delta', (ev) => {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
        parser.write(ev.delta);
      });
      response = await stream.finalResponse();
      try {
        parser.end();
      } catch {
        /* truncated tail: the values already handed over stand */
      }
    } else {
      response = await this.client.responses.parse(body, { signal: request.signal });
    }
    const inputTokens = response.usage?.input_tokens ?? 0;
    const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const usage: Usage = {
      model: this.opts.model,
      inputTokens,
      cachedTokens,
      outputTokens,
      usd: priceUsd(this.opts.model, inputTokens, cachedTokens, outputTokens),
      firstTokenMs,
      totalMs: Math.round(performance.now() - started),
    };
    this.meter.record({ ...usage, purpose: request.purpose });
    const value = response.output_parsed;
    if (value === null || value === undefined)
      throw new Error(`LLM_NO_OUTPUT: ${response.status ?? 'unknown'}`);
    return { value: request.schema.parse(value), usage };
  }
}
