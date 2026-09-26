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
  pace: 1,
  // Never chose a board; the device's copy is the whole preference.
  board: null,
  defaultExpertId: null,
  checkIns: true,
};

export const SIGNED_IN: Participant = {
  id: 'p_account_00001',
  name: 'Ada Lovelace',
  plan: 'standard',
  anonymous: false,
  email: 'ada@example.com',
  avatarUrl: null,
  pace: 1,
  // Never chose a board; the device's copy is the whole preference.
  board: null,
  defaultExpertId: null,
  checkIns: true,
};

/** A platform with nothing real behind it: no analytics, no Sentry, no Google. */
export function testPlatform(storage: KeyValueStorage = memoryStorage()): Platform {
  return {
    name: 'web',
    id: 'web',
    basePath: '/',
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
  /** Overrides on the test platform: a Google client id, a different host name. */
  platform?: Partial<Platform>;
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
  /** Every request the screen made, as `METHOD /path`, in order. */
  calls: string[];
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

  // Answers are looked up by `METHOD /path` first, then by path alone, so a screen that
  // reads and writes the same path can be given both. An answer may name its own status
  // (`{ __status: 429, error, message }`) for what a screen says when the server declines.
  const calls: string[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const body = answers[`${method} ${url.pathname}`] ?? answers[url.pathname];
    if (body === undefined)
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    const { __status, ...payload } =
      typeof body === 'object' && body !== null
        ? (body as { __status?: number } & Record<string, unknown>)
        : { __status: undefined };
    return new Response(
      JSON.stringify(typeof body === 'object' && body !== null ? payload : body),
      {
        status: typeof __status === 'number' ? __status : 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  globalThis.fetch = fetchMock as typeof fetch;

  useLists.getState().reset();
  const platform = { ...testPlatform(storage), ...options.platform };
  const result = render(
    <AppProvider platform={platform}>
      <ToastProvider>
        <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
      </ToastProvider>
    </AppProvider>,
  );
  return { ...result, storage, calls };
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
    // An answer may name its own status (`{ __status: 429, error, message }`) for the
    // screens that have something to say when the server declines.
    const { __status, ...payload } = (body ?? {}) as { __status?: number } & Record<
      string,
      unknown
    >;
    return new Response(
      JSON.stringify(typeof body === 'object' && body !== null ? payload : body),
      {
        status: typeof __status === 'number' ? __status : 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
  return new ApiClient('http://api.test', memoryStorage({ 'pen.token': 'test-token' }));
}
