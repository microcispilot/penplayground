import { describe, expect, it } from 'vitest';
import { chooseSearchProvider, ExaSearch, NoSearch, SearchError, TavilySearch } from '../src/search.js';

function capture(reply: unknown, status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

describe('TavilySearch', () => {
  it('posts the documented request shape with a bearer key and maps results', async () => {
    const { fetchImpl, calls } = capture({ results: [{ title: 'Optionals', url: 'https://docs.swift.org/x', content: 'snippet', score: 0.8 }], response_time: '0.5' });
    const provider = new TavilySearch({ apiKey: 'tvly-test', fetchImpl });
    const hits = await provider.search({ query: 'swift optionals', maxResults: 5, signal: new AbortController().signal });
    expect(hits).toEqual([{ url: 'https://docs.swift.org/x', title: 'Optionals', snippet: 'snippet', score: 0.8 }]);
    const call = calls[0];
    expect(call?.url).toBe('https://api.tavily.com/search');
    expect(call?.init?.method).toBe('POST');
    expect((call?.init?.headers as Record<string, string>).authorization).toBe('Bearer tvly-test');
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ query: 'swift optionals', max_results: 5, search_depth: 'basic', include_raw_content: false });
    expect(Array.isArray(body.exclude_domains)).toBe(true);
  });

  it('throws a SearchError with the status on failure', async () => {
    const { fetchImpl } = capture({ detail: 'bad key' }, 401);
    const provider = new TavilySearch({ apiKey: 'x', fetchImpl });
    await expect(provider.search({ query: 'q', maxResults: 1, signal: new AbortController().signal })).rejects.toBeInstanceOf(SearchError);
  });
});

describe('ExaSearch', () => {
  it('uses the x-api-key header, numResults and text contents', async () => {
    const { fetchImpl, calls } = capture({ results: [{ title: null, url: 'https://a.example', text: 'body', score: null }] });
    const provider = new ExaSearch({ apiKey: 'exa-test', fetchImpl });
    const hits = await provider.search({ query: 'q', maxResults: 3, signal: new AbortController().signal });
    expect(hits).toEqual([{ url: 'https://a.example', title: '', snippet: 'body', score: null }]);
    const call = calls[0];
    expect(call?.url).toBe('https://api.exa.ai/search');
    expect((call?.init?.headers as Record<string, string>)['x-api-key']).toBe('exa-test');
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({ query: 'q', numResults: 3, contents: { text: { maxCharacters: 400 } } });
  });
});

describe('chooseSearchProvider', () => {
  it('picks Tavily, then Exa, then none', () => {
    expect(chooseSearchProvider({ TAVILY_API_KEY: 'a', EXA_API_KEY: 'b' }).name).toBe('tavily');
    expect(chooseSearchProvider({ EXA_API_KEY: 'b' }).name).toBe('exa');
    expect(chooseSearchProvider({ TAVILY_API_KEY: '  ' })).toBeInstanceOf(NoSearch);
  });

  it('NoSearch returns nothing', async () => {
    expect(await new NoSearch().search()).toEqual([]);
  });
});
