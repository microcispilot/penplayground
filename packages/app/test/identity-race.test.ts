import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { ANONYMOUS, memoryStorage } from './harness.js';
import { roomState } from './room-fixtures.js';

/**
 * Identity is issued once, and nothing that needs it goes out before it.
 *
 * Every visit begins the same way: the shell mounts, `ensureParticipant()`
 * posts to `/api/auth/anonymous`, and a bearer comes back. Until it does, this
 * client has no bearer — and *that window is a real one*. On a warm connection
 * it is tens of milliseconds; on a cold one, or a slow phone, it is long
 * enough for a learner to type a topic and press Start, which is exactly how
 * it was found.
 *
 * Three separate bugs live in that window, and they are all the same shape:
 * a field read, an `await`, and the field read again on the other side.
 *
 *   1. `ensureParticipant()` was not single-flight. `if (this.token)` is read,
 *      the POST is awaited, and `this.token` is written after. Two callers in
 *      that window — the provider's mount effect and a rename, StrictMode's
 *      double mount, a retry — each see no token, each mint a participant, and
 *      the second write wins. The first row is orphaned with whatever was
 *      already attached to it.
 *   2. Any authed call made in the window went out with **no** `authorization`
 *      header, because `request()` reads `this.token` at send time.
 *   3. The UI papered over (2) by refusing to act: Home checked `participant`
 *      and dropped the click with "Connecting to Pen Playground…". A dead
 *      button is not a fix for a race; it is the race, made visible.
 *
 * The seam is the client, so the fix is here rather than in each screen. One
 * in-flight promise, and every call that needs a bearer waits for it.
 */

const HELD = Symbol('held');

interface Rig {
  api: ApiClient;
  /** Every request the client made, in order, with the bearer it carried. */
  calls: { path: string; method: string; bearer: string | null }[];
  /** Let the held `/api/auth/anonymous` answer. */
  release: () => void;
  /** Let it fail instead. */
  fail: (message: string) => void;
  minted: () => number;
}

/**
 * A client whose anonymous mint is under the test's control: it does not
 * answer until `release()` (or `fail()`) is called, which is the window.
 */
function rig(opts: { token?: string } = {}): Rig {
  const calls: Rig['calls'] = [];
  // One gate per mint, not one for the whole rig: a retry after a failure has
  // to be able to reach a *fresh* gate, or the test cannot tell a single-flight
  // that clears its slot from one that caches the rejection for ever.
  const gates: ((v: typeof HELD | Error) => void)[] = [];
  const settleAll = (v: typeof HELD | Error) => {
    for (const g of gates.splice(0)) g(v);
  };
  let minted = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      bearer: headers.authorization?.replace(/^Bearer /, '') ?? null,
    });

    if (url.pathname === '/api/auth/anonymous') {
      minted += 1;
      const mine = minted;
      const outcome = await new Promise<typeof HELD | Error>((resolve) => gates.push(resolve));
      if (outcome instanceof Error) throw outcome;
      return json({ token: `bearer-${mine}`, participant: { ...ANONYMOUS, id: `p_${mine}` } });
    }
    if (url.pathname === '/api/me') return json({ participant: ANONYMOUS });
    if (url.pathname === '/api/sessions' && init?.method === 'POST')
      return json({ session: SESSION, state: STATE });
    if (url.pathname === '/api/sessions') return json({ sessions: [] });
    if (url.pathname === '/api/experts') return json({ experts: [] });
    return json({});
  }) as typeof fetch;

  const storage = memoryStorage(opts.token ? { 'pen.token': opts.token } : {});
  return {
    api: new ApiClient('http://api.test', storage),
    calls,
    release: () => settleAll(HELD),
    fail: (message) => settleAll(new Error(message)),
    minted: () => minted,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const SESSION = {
  id: 's_session_0001',
  topic: 'How Transformers work in LLMs',
  title: 'How Transformers work in LLMs',
  promise: 'See how a sentence becomes vectors.',
  expertId: 'e_1',
  hostId: 'p_1',
  hostName: 'Learner',
  band: 'beginner',
  domain: 'Computing',
  visibility: 'public',
  startedAt: 0,
  endedAt: null,
  durationMs: 0,
  segments: 0,
  questions: 0,
  recap: [],
  views: 0,
  thumbnail: null,
};
const STATE = roomState(1, { sessionId: 's_session_0001' });

/** A turn of the microtask queue, plus a macrotask, so a held fetch can settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('the identity window', () => {
  it('mints one participant however many callers ask at once', async () => {
    const r = rig();
    const [a, b, c] = [
      r.api.ensureParticipant(),
      r.api.ensureParticipant(),
      r.api.ensureParticipant(),
    ];
    await flush();
    r.release();
    const all = await Promise.all([a, b, c]);

    expect(r.minted(), 'three callers, one POST /api/auth/anonymous').toBe(1);
    expect(new Set(all.map((p) => p.id)).size, 'and one participant between them').toBe(1);
  });

  it('a call made inside the window still carries the bearer', async () => {
    const r = rig();
    const identity = r.api.ensureParticipant();
    // The learner types and presses Start before the mint has answered.
    const started = r.api.createSession({ topic: 'How Transformers work in LLMs' });
    await flush();
    r.release();
    await identity;
    await started;

    const create = r.calls.find((c) => c.path === '/api/sessions' && c.method === 'POST');
    expect(create, 'the session was created').toBeDefined();
    expect(create?.bearer, 'and it was created as somebody').toBe('bearer-1');
  });

  it('does not make the public catalogue wait for identity', async () => {
    const r = rig();
    const identity = r.api.ensureParticipant();
    // Never released: the page must still paint.
    await expect(r.api.listPublicSessions()).resolves.toEqual([]);
    r.release();
    await identity;
  });

  it('hands a failed mint to whoever was waiting, rather than hanging', async () => {
    const r = rig();
    const identity = r.api.ensureParticipant().catch((e: unknown) => e);
    const started = r.api.createSession({ topic: 'anything' });
    await flush();
    r.fail('offline');

    await expect(started).rejects.toThrow();
    expect(await identity).toBeInstanceOf(Error);
  });

  it('lets the next caller try again after a failure', async () => {
    const r = rig();
    const failed = r.api.ensureParticipant();
    await flush();
    r.fail('offline');
    await expect(failed).rejects.toThrow();

    // A single-flight that never clears its slot would replay the failure for
    // ever; the retry has to reach the network again.
    const before = r.minted();
    const retry = r.api.ensureParticipant();
    await flush();
    r.release();
    await expect(retry).resolves.toMatchObject({ id: `p_${before + 1}` });
    expect(r.minted(), 'the retry posted again').toBe(before + 1);
  });

  it('a call after a failed mint asks for identity again, rather than going out bare', async () => {
    const r = rig();
    const failed = r.api.ensureParticipant();
    await flush();
    r.fail('offline');
    await expect(failed).rejects.toThrow();

    const started = r.api.createSession({ topic: 'How Transformers work in LLMs' });
    await flush();
    r.release();
    await started;

    const create = r.calls.find((c) => c.path === '/api/sessions' && c.method === 'POST');
    expect(create?.bearer, 'the retry minted, and the session carried it').toBe('bearer-2');
  });

  it('an existing bearer is checked once, not once per caller', async () => {
    const r = rig({ token: 'already-signed-in' });
    const all = await Promise.all([r.api.ensureParticipant(), r.api.ensureParticipant()]);
    expect(all.map((p) => p.id)).toEqual([ANONYMOUS.id, ANONYMOUS.id]);
    expect(r.calls.filter((c) => c.path === '/api/me').length, 'one GET /api/me').toBe(1);
  });
});
