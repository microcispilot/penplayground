import type { LessonEvent, TelemetryPort } from '@pen/contracts';
import { imageCostLines, llmCostLines } from '@pen/contracts';
import type {
  CompletionRequest,
  EventStream,
  EventStreamRequest,
  GeneratedImage,
  ImageModel,
  ImageRequest,
  LanguageModel,
  Usage,
} from './types.js';

/** A stable, content-free code from a thrown error ("LLM_REFUSAL: …" → "LLM_REFUSAL"). */
export function llmErrorCode(error: unknown): string {
  return errorCode('LLM', error);
}

/** The same, for the image endpoint ("IMAGE_NOT_PNG: …" → "IMAGE_NOT_PNG"); a 429 becomes "IMAGE_ERROR". */
export function imageErrorCode(error: unknown): string {
  return errorCode('IMAGE', error);
}

function errorCode(prefix: 'LLM' | 'IMAGE', error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const head = message.split(':')[0]?.trim() ?? '';
  const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(head) ? head : `${prefix}_ERROR`;
  return code.startsWith(`${prefix}_`) ? code : `${prefix}_${code}`.slice(0, 80);
}

/**
 * Wraps a model so every call becomes one `llm` stage sample (first token,
 * total, tokens) and three cost lines (uncached input, cached input, output)
 * on the given telemetry port. Failures are samples with `ok: false` and a
 * `code`; the caller that catches the error records the ledger `error` entry
 * (it owns the Sentry capture and its ref). The wrapper is per session: the
 * underlying model may be shared across sessions, the port is not.
 */
export function withTelemetry(model: LanguageModel, telemetry: TelemetryPort): LanguageModel {
  const record = (usage: Usage, purpose: string, ok: boolean, startedAt: number): void => {
    telemetry.sample({
      stage: 'llm',
      ms: usage.totalMs,
      ok,
      startedAt,
      meta: {
        purpose,
        model: usage.model,
        firstTokenMs: usage.firstTokenMs ?? -1,
        tokensIn: usage.inputTokens,
        tokensCached: usage.cachedTokens,
        tokensOut: usage.outputTokens,
        usd: usage.usd,
        reused: false,
      },
    });
    for (const line of llmCostLines(usage, { purpose, reused: false })) telemetry.cost(line);
  };
  return {
    id: model.id,
    streamEvents(request: EventStreamRequest): EventStream {
      const startedAt = Date.now();
      const stream = model.streamEvents(request);
      let failed = false;
      const inner = stream[Symbol.asyncIterator]();
      const iterator: AsyncIterator<LessonEvent> = {
        next: async () => {
          try {
            return await inner.next();
          } catch (error) {
            failed = true;
            throw error;
          }
        },
        return: async (value) => {
          if (inner.return) return inner.return(value);
          return { value: undefined as never, done: true };
        },
      };
      const usage = stream.usage.then((u) => {
        record(u, request.purpose, !failed, startedAt);
        return u;
      });
      return { [Symbol.asyncIterator]: () => iterator, usage, abort: () => stream.abort() };
    },
    async complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: Usage }> {
      const startedAt = Date.now();
      try {
        const result = await model.complete(request);
        record(result.usage, request.purpose, true, startedAt);
        return result;
      } catch (error) {
        telemetry.sample({
          stage: 'llm',
          ms: Date.now() - startedAt,
          ok: false,
          startedAt,
          meta: {
            purpose: request.purpose,
            model: model.id,
            firstTokenMs: -1,
            code: llmErrorCode(error),
          },
        });
        throw error;
      }
    },
  };
}

/**
 * The same wrap for the image model: one `image` stage sample and two cost
 * lines (the prompt in, the picture out) per generation, so a session's card
 * picture is priced in its ledger exactly like every other provider call.
 * A failure is a sample with `ok: false` and a code; the caller that catches
 * the error owns the Sentry capture.
 */
export function withImageTelemetry(model: ImageModel, telemetry: TelemetryPort): ImageModel {
  return {
    id: model.id,
    async generate(request: ImageRequest): Promise<GeneratedImage> {
      const startedAt = Date.now();
      try {
        const result = await model.generate(request);
        const { usage } = result;
        telemetry.sample({
          stage: 'image',
          ms: usage.totalMs,
          ok: true,
          startedAt,
          meta: {
            purpose: request.purpose,
            model: usage.model,
            quality: request.quality,
            size: `${request.size.width}x${request.size.height}`,
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            bytes: result.png.length,
            usd: usage.usd,
            reused: false,
          },
        });
        for (const line of imageCostLines(usage, { purpose: request.purpose, reused: false }))
          telemetry.cost(line);
        return result;
      } catch (error) {
        telemetry.sample({
          stage: 'image',
          ms: Date.now() - startedAt,
          ok: false,
          startedAt,
          meta: {
            purpose: request.purpose,
            model: model.id,
            code: imageErrorCode(error),
          },
        });
        throw error;
      }
    },
  };
}
