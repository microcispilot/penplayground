import { describe, expect, it } from 'vitest';
import { ApiClient, type Participant } from '../src/api/client.js';
import { PACE_PREFERENCE_KEY, readPacePreference } from '../src/lib/pace-preference.js';
import { memoryStorage } from './harness.js';

/**
 * The client half of "the pace is kept on your account" (ADR-0010).
 *
 * The server half is `services/api/test/pace-account.test.ts`. What is left
 * to hold here is the etiquette: an anonymous learner's device is never
 * spoken for, a signed-in learner's account is written once per change and
 * in order, and a write that fails leaves the next change free to try again.
 */

const SIGNED_IN: Participant = {
  id: 'p_account_00001',
  name: 'Ada Lovelace',
  plan: 'standard',
  anonymous: false,
  email: 'ada@example.com',
  avatarUrl: null,
  pace: 1,
  // Never chose a board; the device's copy is the whole preference.
  board: null,
};

interface Rig {
  api: ApiClient;
  calls: { pace: number }[];
  /** Resolve or reject the nth PATCH by hand. */
  settle: ((ok: boolean) => void)[];
}

/** An ApiClient whose `/api/me` is under the test's control. */
function rig(participant: Participant, opts: { hold?: boolean } = {}): Rig {
  const calls: { pace: number }[] = [];
  const settle: ((ok: boolean) => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    const body = init?.body ? (JSON.parse(String(init.body)) as { pace?: number }) : {};
    if (url.pathname === '/api/me' && init?.method === 'PATCH') {
      const pace = body.pace ?? participant.pace;
      calls.push({ pace });
      if (opts.hold)
        await new Promise<void>((resolve, reject) =>
          settle.push((ok) => (ok ? resolve() : reject(new Error('offline')))),
        );
      return new Response(JSON.stringify({ participant: { ...participant, pace } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ participant }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const api = new ApiClient('http://api.test', memoryStorage({ 'pen.token': 'test-token' }));
  return { api, calls, settle };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('remembering the pace on the account', () => {
  it('says nothing for an anonymous learner: their device already decides', async () => {
    const { api, calls } = rig({ ...SIGNED_IN, anonymous: true });
    await api.ensureParticipant();
    api.rememberPace(1.3);
    await flush();
    expect(calls).toEqual([]);
  });

  it('writes a signed-in learner’s pace once, and not again for the same value', async () => {
    const { api, calls } = rig(SIGNED_IN);
    await api.ensureParticipant();
    api.rememberPace(1.3);
    await flush();
    api.rememberPace(1.3);
    await flush();
    expect(calls).toEqual([{ pace: 1.3 }]);
  });

  it('writes in order and skips a value that was overtaken before it was sent', async () => {
    const held = rig(SIGNED_IN, { hold: true });
    await held.api.ensureParticipant();
    held.api.rememberPace(0.9);
    await flush();
    // The first request is in flight; two more changes arrive behind it.
    held.api.rememberPace(1.15);
    held.api.rememberPace(1.3);
    held.settle[0]?.(true);
    await flush();
    held.settle[1]?.(true);
    await flush();
    // 1.15 was overtaken before it reached the wire; 1.3 is what the account gets.
    expect(held.calls.map((c) => c.pace)).toEqual([0.9, 1.3]);
  });

  it('lets the next change try again after a write that failed', async () => {
    const held = rig(SIGNED_IN, { hold: true });
    await held.api.ensureParticipant();
    held.api.rememberPace(1.3);
    await flush();
    held.settle[0]?.(false);
    await flush();
    // The account never took 1.3, so asking for it again really asks again.
    held.api.rememberPace(1.3);
    await flush();
    held.settle[1]?.(true);
    await flush();
    expect(held.calls.map((c) => c.pace)).toEqual([1.3, 1.3]);
  });
});

describe('the device adopts the account’s pace', () => {
  it('is what `readPacePreference` reads back after a signed-in boot', () => {
    const storage = memoryStorage({ [PACE_PREFERENCE_KEY]: '1.3' });
    // What AppProvider does with the participant it boots with.
    const adopt = (p: Participant) => {
      if (!p.anonymous) storage.set(PACE_PREFERENCE_KEY, String(p.pace));
    };
    adopt({ ...SIGNED_IN, pace: 0.75 });
    expect(readPacePreference(storage)).toBe(0.75);
    // An anonymous participant speaks for nobody: the device keeps its own.
    adopt({ ...SIGNED_IN, anonymous: true, pace: 1 });
    expect(readPacePreference(storage)).toBe(0.75);
  });
});
