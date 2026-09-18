import { ToastProvider } from '@pen/design';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { ApiClient, type Participant } from '../src/api/client.js';
import { AppProvider } from '../src/lib/context.js';
import { useLists } from '../src/lib/lists.js';
import type { KeyValueStorage, Platform } from '../src/platform/types.js';

/** A storage the tests can look inside, with the same swallow-everything contract as the hosts'. */
export function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
}

export const ANONYMOUS: Participant = {
  id: 'p_anonymous_0001',
  name: 'Learner',
  plan: 'free',
  anonymous: true,
  email: null,
  avatarUrl: null,
};

export const SIGNED_IN: Participant = {
  id: 'p_account_00001',
  name: 'Ada Lovelace',
  plan: 'standard',
  anonymous: false,
  email: 'ada@example.com',
  avatarUrl: null,
};

/** A platform with nothing real behind it: no analytics, no Sentry, no Google. */
export function testPlatform(storage: KeyValueStorage = memoryStorage()): Platform {
  return {
    name: 'web',
    apiUrl: 'http://api.test',
    speech: {
      create: () => ({
        start: async () => undefined,
        stop: () => undefined,
        available: false,
        label: 'none',
      }),
    },
    mic: { workletSource: '', createResamplerWorker: () => ({}) as Worker },
    storage,
    openExternal: () => undefined,
    tldrawLicenseKey: '',
    sentryDsn: null,
    analytics: null,
    googleClientId: null,
  };
}

export interface HarnessOptions {
  participant?: Participant | null;
  storage?: KeyValueStorage;
  route?: string;
  /** What `fetch` answers, by path; anything else 404s. */
  routes?: Record<string, unknown>;
}

/**
 * Renders a piece of the product with a participant already in place. The
 * AppProvider issues its participant through the API client, so the harness
 * answers `/api/me` (and whatever else the screen asks for) from `routes`.
 */
export function renderWithApp(
  ui: ReactNode,
  options: HarnessOptions = {},
): RenderResult & {
  storage: KeyValueStorage & { data: Map<string, string> };
} {
  const storage = (options.storage ?? memoryStorage()) as KeyValueStorage & {
    data: Map<string, string>;
  };
  const participant = options.participant === undefined ? ANONYMOUS : options.participant;
  const answers: Record<string, unknown> = {
    '/api/me': { participant },
    '/api/me/lists': {
      savedIds: [],
      likedIds: [],
      counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
    },
    ...options.routes,
  };
  // A token must already be there, or the client mints an anonymous one of its own.
  if (participant) storage.set('pen.token', 'test-token');

  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    const body = answers[url.pathname];
    return new Response(JSON.stringify(body ?? { error: 'NOT_FOUND' }), {
      status: body === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.fetch = fetchMock as typeof fetch;

  useLists.getState().reset();
  const platform = testPlatform(storage);
  const result = render(
    <AppProvider platform={platform}>
      <ToastProvider>
        <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
      </ToastProvider>
    </AppProvider>,
  );
  return { ...result, storage };
}

/** The API client the store tests drive directly, with a scripted transport. */
export function testApi(answers: Record<string, unknown>, calls: string[] = []): ApiClient {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const body = answers[`${init?.method ?? 'GET'} ${url.pathname}`] ?? answers[url.pathname];
    if (body === undefined)
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    if (body instanceof Error)
      return new Response(JSON.stringify({ error: 'BOOM', message: body.message }), {
        status: 500,
      });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return new ApiClient('http://api.test', memoryStorage({ 'pen.token': 'test-token' }));
}
