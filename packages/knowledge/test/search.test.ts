import { describe, expect, it } from 'vitest';
import {
  chooseSearchProvider,
  ExaSearch,
  NoSearch,
  SearchError,
  SearxngSearch,
  TavilySearch,
} from '../src/search.js';

function capture(
  reply: unknown,
  status = 200,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('TavilySearch', () => {
  it('posts the documented request shape with a bearer key and maps results', async () => {
    const { fetchImpl, calls } = capture({
      results: [
        { title: 'Optionals', url: 'https://docs.swift.org/x', content: 'snippet', score: 0.8 },
      ],
      response_time: '0.5',
    });
    const provider = new TavilySearch({ apiKey: 'tvly-test', fetchImpl });
    const hits = await provider.search({
      query: 'swift optionals',
      maxResults: 5,
      signal: new AbortController().signal,
    });
    expect(hits).toEqual([
      { url: 'https://docs.swift.org/x', title: 'Optionals', snippet: 'snippet', score: 0.8 },
    ]);
    const call = calls[0];
    expect(call?.url).toBe('https://api.tavily.com/search');
    expect(call?.init?.method).toBe('POST');
    expect((call?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer tvly-test',
    );
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: 'swift optionals',
      max_results: 5,
      search_depth: 'basic',
      include_raw_content: false,
    });
    expect(Array.isArray(body.exclude_domains)).toBe(true);
  });

  it('throws a SearchError with the status on failure', async () => {
    const { fetchImpl } = capture({ detail: 'bad key' }, 401);
    const provider = new TavilySearch({ apiKey: 'x', fetchImpl });
    await expect(
      provider.search({ query: 'q', maxResults: 1, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(SearchError);
  });
});

describe('ExaSearch', () => {
  it('uses the x-api-key header, numResults and text contents', async () => {
    const { fetchImpl, calls } = capture({
      results: [{ title: null, url: 'https://a.example', text: 'body', score: null }],
    });
    const provider = new ExaSearch({ apiKey: 'exa-test', fetchImpl });
    const hits = await provider.search({
      query: 'q',
      maxResults: 3,
      signal: new AbortController().signal,
    });
    expect(hits).toEqual([{ url: 'https://a.example', title: '', snippet: 'body', score: null }]);
    const call = calls[0];
    expect(call?.url).toBe('https://api.exa.ai/search');
    expect((call?.init?.headers as Record<string, string> | undefined)?.['x-api-key']).toBe(
      'exa-test',
    );
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      query: 'q',
      numResults: 3,
      contents: { text: { maxCharacters: 400 } },
    });
  });
});

describe('SearxngSearch', () => {
  const signal = () => new AbortController().signal;

  it('GETs /search?format=json with language, safesearch and categories, and maps rows', async () => {
    const { fetchImpl, calls } = capture({
      query: 'swift optionals',
      number_of_results: 0,
      results: [
        {
          url: 'https://docs.swift.org/x',
          title: 'Optionals',
          content: 'snippet',
          score: 4,
          engine: 'google',
          category: 'general',
        },
        { url: 'https://b.example', title: 'B', content: null, score: 2 },
      ],
      suggestions: [],
    });
    const provider = new SearxngSearch({ baseUrl: 'http://127.0.0.1:8080/', fetchImpl });
    const hits = await provider.search({
      query: 'swift optionals',
      maxResults: 5,
      signal: signal(),
    });
    expect(hits).toEqual([
      { url: 'https://docs.swift.org/x', title: 'Optionals', snippet: 'snippet', score: 1 },
      { url: 'https://b.example', title: 'B', snippet: '', score: 0.5 },
    ]);
    const call = calls[0];
    const url = new URL(String(call?.url));
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:8080/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'swift optionals',
      format: 'json',
      language: 'en',
      safesearch: '1',
      categories: 'general',
    });
    expect(call?.init?.method).toBe('GET');
    expect((call?.init?.headers as Record<string, string> | undefined)?.accept).toBe(
      'application/json',
    );
  });

  it('caps at maxResults, drops duplicates and excluded hosts, honours the language option', async () => {
    const row = (url: string) => ({ url, title: url, content: '', score: 1 });
    const { fetchImpl, calls } = capture({
      results: [
        row('https://a.example/1'),
        row('https://www.youtube.com/watch?v=1'),
        row('https://a.example/1'),
        row('https://a.example/2'),
        row('https://a.example/3'),
      ],
    });
    const provider = new SearxngSearch({
      baseUrl: 'http://searxng:8080',
      fetchImpl,
      language: 'de',
    });
    const hits = await provider.search({ query: 'q', maxResults: 2, signal: signal() });
    expect(hits.map((h) => h.url)).toEqual(['https://a.example/1', 'https://a.example/2']);
    expect(new URL(String(calls[0]?.url)).searchParams.get('language')).toBe('de');
  });

  it('reports a disabled json format (403) as a SearchError', async () => {
    const { fetchImpl } = capture({}, 403);
    const provider = new SearxngSearch({ baseUrl: 'http://searxng:8080', fetchImpl });
    await expect(
      provider.search({ query: 'q', maxResults: 1, signal: signal() }),
    ).rejects.toMatchObject({ name: 'SearchError', provider: 'searxng', status: 403 });
  });

  it('wraps network failures and malformed bodies in SearchError', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      new SearxngSearch({ baseUrl: 'http://searxng:8080', fetchImpl: down }).search({
        query: 'q',
        maxResults: 1,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ name: 'SearchError', status: 0 });

    const html: typeof fetch = async () => new Response('<html>', { status: 200 });
    await expect(
      new SearxngSearch({ baseUrl: 'http://searxng:8080', fetchImpl: html }).search({
        query: 'q',
        maxResults: 1,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ name: 'SearchError', status: 200 });
  });

  it('gives up after the timeout', async () => {
    const never: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const provider = new SearxngSearch({
      baseUrl: 'http://searxng:8080',
      fetchImpl: never,
      timeoutMs: 20,
    });
    await expect(
      provider.search({ query: 'q', maxResults: 1, signal: signal() }),
    ).rejects.toMatchObject({ name: 'SearchError', status: 0 });
  });

  it("lets the caller's own cancellation through untouched", async () => {
    const ac = new AbortController();
    const never: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const provider = new SearxngSearch({ baseUrl: 'http://searxng:8080', fetchImpl: never });
    const pending = provider.search({ query: 'q', maxResults: 1, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.not.toBeInstanceOf(SearchError);
  });
});

describe('chooseSearchProvider', () => {
  it('picks SearXNG, then Tavily, then Exa, then none', () => {
    expect(
      chooseSearchProvider({ SEARXNG_URL: 'http://searxng:8080', TAVILY_API_KEY: 'a' }).name,
    ).toBe('searxng');
    expect(chooseSearchProvider({ SEARXNG_URL: '  ', TAVILY_API_KEY: 'a' }).name).toBe('tavily');
    expect(chooseSearchProvider({ TAVILY_API_KEY: 'a', EXA_API_KEY: 'b' }).name).toBe('tavily');
    expect(chooseSearchProvider({ EXA_API_KEY: 'b' }).name).toBe('exa');
    expect(chooseSearchProvider({ TAVILY_API_KEY: '  ' })).toBeInstanceOf(NoSearch);
  });

  it('NoSearch returns nothing', async () => {
    expect(await new NoSearch().search()).toEqual([]);
  });
});
