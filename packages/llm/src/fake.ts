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
 * A scripted structured-output answer. `purpose` picks it; `match` narrows
 * further when one purpose has more than one answer (a lesson taught in
 * Persian plans, recaps and draws its card in Persian).
 */
export interface FakeCompletion {
  purpose: string;
  value: unknown;
  match?: (request: CompletionRequest<unknown>) => boolean;
}

/** Scripts write `{{expert}}` where the persona's first name belongs. */
const EXPERT_PLACEHOLDER = /\{\{expert\}\}/g;

/** The persona's first name, read from the system prompt (`YOU ARE <name>, <role>.`). */
export function expertFirstName(request: EventStreamRequest): string | null {
  const system = request.messages.find((m) => m.role === 'system');
  const match = system?.content.match(/YOU ARE ([^,\n]+)/);
  const first = match?.[1]?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

function personalise(ev: LessonEvent, name: string | null): LessonEvent {
  if (name === null || !('text' in ev) || typeof ev.text !== 'string') return ev;
  return { ...ev, text: ev.text.replace(EXPERT_PLACEHOLDER, name) };
}

/**
 * Deterministic model for tests, demos and offline development. Streams
 * scripted events with realistic pacing so the conductor, TTS and board are
 * exercised end to end without an API key. `{{expert}}` in a script's text is
 * replaced with the persona the request is for, so demos and exports greet
 * the learner with the right name.
 */
export class FakeLanguageModel implements LanguageModel {
  readonly id = 'fake';
  constructor(
    private readonly scripts: FakeScript[],
    private readonly completions: FakeCompletion[] = [],
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
    const name = expertFirstName(request);
    const events = script.events.map((ev) => personalise(ev, name));
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
    const c = this.completions.find(
      (x) =>
        x.purpose === request.purpose &&
        (x.match === undefined || x.match(request as CompletionRequest<unknown>)),
    );
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
