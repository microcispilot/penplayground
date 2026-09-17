import type { PreparationProgress, SourceDocument } from '@pen/contracts';
import { FakeLanguageModel } from '@pen/llm';
import type {
  CompileProgress,
  Pack,
  ProgressiveCompilation,
  ProvisionalReceipt,
  QualifiedPackReference,
  TopicResolution,
} from '@pen/onten';
import { PEN_HOST_POLICY } from '@pen/onten';
import { EVALSET_PURPOSE, OUTLINE_PURPOSE } from '../src/outline.js';
import type { Seed } from '../src/seeds.js';
import type { KnowledgeObserver, Transform } from '../src/types.js';

export interface Route {
  body: string;
  status?: number;
  type?: string;
  delayMs?: number;
}

export interface FetchLogEntry {
  url: string;
  at: number;
}

function guessType(url: string): string {
  if (/\.md$/.test(url)) return 'text/markdown; charset=utf-8';
  if (/\.json$|api\.php/.test(url)) return 'application/json';
  if (/\.txt$/.test(url)) return 'text/plain';
  return 'text/html; charset=utf-8';
}

/** In-memory fetch: routes keyed by exact URL; unknown URLs 404 (robots.txt included → allow-all). */
export function fakeFetch(
  routes: Record<string, Route | string>,
  log: FetchLogEntry[] = [],
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    log.push({ url, at: performance.now() });
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    const r: Route = typeof route === 'string' ? { body: route } : route;
    if (r.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    }
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { 'content-type': r.type ?? guessType(url) },
    });
  };
}

/** Enough markdown for several Onten units. */
export function markdownDoc(title: string, sections = 4): string {
  const parts = [
    `# ${title}`,
    '',
    `${title} is explained here in enough detail for a lesson segment to be built from it.`,
  ];
  for (let i = 1; i <= sections; i++) {
    parts.push(
      '',
      `## ${title} part ${i}`,
      '',
      `Paragraph ${i} of ${title}. `.repeat(12).trim(),
      '',
      '```swift',
      `let value${i} = ${i}`,
      '```',
    );
  }
  return parts.join('\n');
}

export function htmlDoc(title: string, paragraphs = 6): string {
  const body = Array.from(
    { length: paragraphs },
    (_, i) => `<p>Paragraph ${i + 1} about ${title}. ${'More detail here. '.repeat(8)}</p>`,
  ).join('\n');
  return `<!doctype html><html><head><title>${title} — Example Docs</title></head><body><nav><a href="/">Home</a></nav><main><h1>${title}</h1>${body}<pre><code class="language-python">print("hi")</code></pre></main><footer>Footer</footer></body></html>`;
}

export interface FakeCompilation {
  compilation: ProgressiveCompilation;
  sources: SourceDocument[];
  evaluation: () => Pack['evaluation'] | undefined;
  finished: () => boolean;
}

/** Minimal ProgressiveCompilation: interactive after N sources, background on finishSources. */
export function fakeCompilation(
  opts: { interactiveAfter: number; packId?: string } = { interactiveAfter: 2 },
): FakeCompilation {
  const packId = opts.packId ?? 'pack_test';
  const sources: SourceDocument[] = [];
  const listeners = new Set<(p: CompileProgress) => void>();
  let evaluation: Pack['evaluation'] | undefined;
  let finished = false;
  let settled = false;
  let resolveInteractive!: (r: ProvisionalReceipt) => void;
  let rejectInteractive!: (e: Error) => void;
  let resolveBackground!: (r: QualifiedPackReference | null) => void;
  const interactive = new Promise<ProvisionalReceipt>((res, rej) => {
    resolveInteractive = res;
    rejectInteractive = rej;
  });
  const background = new Promise<QualifiedPackReference | null>((res) => {
    resolveBackground = res;
  });
  const receipt = (): ProvisionalReceipt => ({
    status: 'partial',
    evidenceTier: 'unverified_live_source',
    attribution: '',
    mayAuthorizeConsequentialDecision: false,
    packId,
    unitCount: sources.length * 3,
    cost: 0,
  });
  const emit = (phase: CompileProgress['phase']) => {
    for (const l of listeners)
      l({ sourcesReceived: sources.length, unitsCompiled: sources.length * 3, phase });
  };
  const compilation: ProgressiveCompilation = {
    interactive,
    background,
    prepared: () => null,
    cancelBackground: () => {
      emit('cancelled');
      resolveBackground(null);
    },
    addSource: async (document) => {
      if (finished) return;
      sources.push(document);
      if (!settled && sources.length >= opts.interactiveAfter) {
        settled = true;
        emit('provisional');
        resolveInteractive(receipt());
      } else emit(settled ? 'provisional' : 'collecting');
    },
    finishSources: (ev) => {
      if (finished) return;
      finished = true;
      evaluation = ev;
      if (!settled) {
        settled = true;
        if (sources.length > 0) resolveInteractive(receipt());
        else rejectInteractive(new Error('CTX-PROGRESSIVE-01 no usable source'));
      }
      const ok =
        sources.length > 0 && (ev?.development.length ?? 0) > 0 && (ev?.negative.length ?? 0) > 0;
      emit(ok ? 'qualified' : 'failed');
      resolveBackground(
        ok ? { packId, packRevision: '2', digest: 'digest', unitCount: sources.length * 3 } : null,
      );
    },
    onProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { compilation, sources, evaluation: () => evaluation, finished: () => finished };
}

export const OUTLINE_VALUE = {
  curriculum: ['Constants and variables', 'Optionals', 'Control flow', 'Functions and closures'],
  queries: [
    'swift constants and variables tutorial',
    'swift optionals explained',
    'swift optional binding examples',
    'swift control flow guide',
    'swift functions tutorial',
    'swift closures explained',
    'swift common beginner mistakes',
    'swift let vs var',
  ],
  candidateUrls: [] as string[],
};

export const EVALSET_VALUE = {
  development: Array.from({ length: 6 }, (_, i) => ({
    question: `Development question number ${i + 1} about Swift?`,
  })),
  negative: Array.from({ length: 4 }, (_, i) => ({
    question: `Negative question number ${i + 1} about something else?`,
  })),
};

export function fakeModel(
  overrides: { candidateUrls?: string[]; failOutline?: boolean; failEvalset?: boolean } = {},
): FakeLanguageModel {
  const completions: Array<{ purpose: string; value: unknown }> = [];
  if (!overrides.failOutline)
    completions.push({
      purpose: OUTLINE_PURPOSE,
      value: { ...OUTLINE_VALUE, candidateUrls: overrides.candidateUrls ?? [] },
    });
  if (!overrides.failEvalset) completions.push({ purpose: EVALSET_PURPOSE, value: EVALSET_VALUE });
  return new FakeLanguageModel([], completions);
}

export function resolutionFor(
  title: string,
  ckid = `en.${title.toLowerCase().replace(/\s+/g, '-')}`,
): TopicResolution {
  return {
    language: 'en',
    canonicalKnowledgeId: ckid,
    title,
    domainBoundary: 'computing-data',
    match: 'miss',
    packId: null,
    lessonMemoId: null,
    score: 0,
  };
}

export function seedFor(
  id: string,
  pattern: RegExp,
  label: string,
  urls: Array<{ url: string; title: string; transform?: Transform; api?: boolean }>,
): Seed {
  return {
    id,
    pattern,
    label,
    priority: 0,
    targets: () =>
      urls.map((u) => ({
        url: u.url,
        title: u.title,
        transform: u.transform ?? 'none',
        ...(u.api ? { api: true } : {}),
      })),
  };
}

export interface RecordingObserver extends KnowledgeObserver {
  events: Array<{ name: string; data: Record<string, unknown> }>;
  errors: Array<{ area: string; error: unknown; data?: Record<string, unknown> }>;
}

export function recordingObserver(): RecordingObserver {
  const events: RecordingObserver['events'] = [];
  const errors: RecordingObserver['errors'] = [];
  return {
    events,
    errors,
    event: (name, data) => {
      events.push({ name, data });
    },
    error: (area, error, data) => {
      errors.push(data ? { area, error, data } : { area, error });
    },
  };
}

export const TEST_BUDGET = {
  perHostGapMs: 0,
  concurrency: 3,
  timeoutMs: 2_000,
  backgroundMs: 10_000,
};

export const POLICY = PEN_HOST_POLICY;

export function collectProgress(): {
  list: PreparationProgress[];
  onProgress: (p: PreparationProgress) => void;
} {
  const list: PreparationProgress[] = [];
  return { list, onProgress: (p) => list.push(p) };
}
