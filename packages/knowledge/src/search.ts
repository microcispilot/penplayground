import { z } from 'zod';
import type { KnowledgeObserver, SearchHit, SearchProvider, SearchRequest } from './types.js';

export class SearchError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} search failed (${status}): ${detail}`);
    this.name = 'SearchError';
  }
}

interface AdapterOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Hosts never worth a search credit (paywalls, media). */
  excludeDomains?: string[];
}

const DEFAULT_EXCLUDES = ['youtube.com', 'x.com', 'twitter.com', 'facebook.com', 'pinterest.com', 'quora.com'];

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ── Tavily ───────────────────────────────────────────────────────────────────
/** docs.tavily.com/documentation/api-reference/endpoint/search (verified 2026-09-16). */
const TavilyResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().catch(''),
      url: z.string(),
      content: z.string().catch(''),
      score: z.number().nullable().catch(null),
    }),
  ),
});

export class TavilySearch implements SearchProvider {
  readonly name = 'tavily';
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: AdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    const { status, json, text } = await postJson(
      this.fetchImpl,
      'https://api.tavily.com/search',
      { authorization: `Bearer ${this.opts.apiKey}` },
      {
        query: request.query,
        search_depth: 'basic',
        topic: 'general',
        max_results: request.maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        exclude_domains: this.opts.excludeDomains ?? DEFAULT_EXCLUDES,
      },
      request.signal,
      this.opts.timeoutMs ?? 15_000,
    );
    if (status < 200 || status >= 300) throw new SearchError(this.name, status, text.slice(0, 200));
    const parsed = TavilyResponse.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, status, 'unexpected response shape');
    return parsed.data.results.map((r) => ({ url: r.url, title: r.title, snippet: r.content, score: r.score }));
  }
}

// ── Exa ──────────────────────────────────────────────────────────────────────
/** docs.exa.ai/reference/search (verified 2026-09-16): x-api-key header, numResults, contents.text. */
const ExaResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullable().catch(null),
      url: z.string(),
      text: z.string().nullable().catch(null),
      score: z.number().nullable().catch(null),
    }),
  ),
});

export class ExaSearch implements SearchProvider {
  readonly name = 'exa';
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: AdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    const { status, json, text } = await postJson(
      this.fetchImpl,
      'https://api.exa.ai/search',
      { 'x-api-key': this.opts.apiKey },
      {
        query: request.query,
        type: 'auto',
        numResults: request.maxResults,
        excludeDomains: this.opts.excludeDomains ?? DEFAULT_EXCLUDES,
        contents: { text: { maxCharacters: 400 } },
      },
      request.signal,
      this.opts.timeoutMs ?? 15_000,
    );
    if (status < 200 || status >= 300) throw new SearchError(this.name, status, text.slice(0, 200));
    const parsed = ExaResponse.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, status, 'unexpected response shape');
    return parsed.data.results.map((r) => ({ url: r.url, title: r.title ?? '', snippet: r.text ?? '', score: r.score }));
  }
}

// ── none ─────────────────────────────────────────────────────────────────────
/** Seeds and the outline's candidate URLs only; no web search. */
export class NoSearch implements SearchProvider {
  readonly name = 'none';
  async search(): Promise<SearchHit[]> {
    return [];
  }
}

/** Pick the adapter for the configured key: Tavily, then Exa, else none. */
export function chooseSearchProvider(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; observer?: KnowledgeObserver } = {},
): SearchProvider {
  const fetchImpl = opts.fetchImpl;
  const tavily = env.TAVILY_API_KEY?.trim();
  if (tavily) return new TavilySearch(fetchImpl ? { apiKey: tavily, fetchImpl } : { apiKey: tavily });
  const exa = env.EXA_API_KEY?.trim();
  if (exa) return new ExaSearch(fetchImpl ? { apiKey: exa, fetchImpl } : { apiKey: exa });
  opts.observer?.event('knowledge.search_provider', { provider: 'none', reason: 'no TAVILY_API_KEY or EXA_API_KEY' });
  return new NoSearch();
}
