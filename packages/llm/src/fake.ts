import type { LessonEvent } from '@pen/contracts';
import type {
  CompletionRequest,
  EventStream,
  EventStreamRequest,
  LanguageModel,
  Usage,
} from './types.js';

export interface FakeScript {
  /** Chosen by matching `purpose` and optionally a substring of the last user message. */
  match: (request: EventStreamRequest) => boolean;
  events: LessonEvent[];
  /** Delay between events, ms (simulates token pacing). */
  gapMs?: number;
}

/**
 * Deterministic model for tests, demos and offline development. Streams
 * scripted events with realistic pacing so the conductor, TTS and board are
 * exercised end to end without an API key.
 */
export class FakeLanguageModel implements LanguageModel {
  readonly id = 'fake';
  constructor(
    private readonly scripts: FakeScript[],
    private readonly completions: Array<{ purpose: string; value: unknown }> = [],
  ) {}

  streamEvents(request: EventStreamRequest): EventStream {
    const script = this.scripts.find((s) => s.match(request));
    if (!script) throw new Error(`FakeLanguageModel: no script for purpose "${request.purpose}"`);
    const gap = script.gapMs ?? 40;
    const controller = new AbortController();
    let resolveUsage!: (u: Usage) => void;
    const usage = new Promise<Usage>((r) => {
      resolveUsage = r;
    });
    const started = performance.now();
    const events = script.events;
    async function* gen(): AsyncGenerator<LessonEvent> {
      let first: number | null = null;
      try {
        for (const ev of events) {
          if (controller.signal.aborted) break;
          await new Promise((r) => setTimeout(r, gap));
          if (first === null) first = Math.round(performance.now() - started);
          yield ev;
        }
      } finally {
        resolveUsage({
          model: 'fake',
          inputTokens: 1200,
          cachedTokens: 900,
          outputTokens: 300,
          usd: 0,
          firstTokenMs: first,
          totalMs: Math.round(performance.now() - started),
        });
      }
    }
    const it = gen();
    return {
      [Symbol.asyncIterator]: () => it,
      usage,
      abort: () => {
        controller.abort();
        void it.return(undefined);
        resolveUsage({
          model: 'fake',
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          usd: 0,
          firstTokenMs: null,
          totalMs: 0,
        });
      },
    };
  }

  async complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: Usage }> {
    const c = this.completions.find((x) => x.purpose === request.purpose);
    if (!c) throw new Error(`FakeLanguageModel: no completion for purpose "${request.purpose}"`);
    return {
      value: request.schema.parse(c.value),
      usage: {
        model: 'fake',
        inputTokens: 500,
        cachedTokens: 0,
        outputTokens: 200,
        usd: 0,
        firstTokenMs: null,
        totalMs: 5,
      },
    };
  }
}
