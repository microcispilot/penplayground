// @vitest-environment happy-dom

import { ToastProvider } from '@pen/design';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../src/lib/context.js';
import { Home } from '../src/screens/Home.js';
import { ANONYMOUS, memoryStorage, testPlatform } from './harness.js';
import { roomState } from './room-fixtures.js';

/**
 * Pressing Start the instant the page paints.
 *
 * The client half of this is `identity-race.test.ts`; this is the half a
 * learner experiences. A first-time visitor lands on Home with no bearer,
 * types a topic and presses Start while `/api/auth/anonymous` is still in
 * flight — which on a cold connection is most of a second. Home used to read
 * `participant` from the context, find it null, say "Connecting to Pen
 * Playground…" and drop the click. The learner pressed a button and nothing
 * happened; the only way forward was to press it again.
 *
 * What must be true instead: one press, one session, no second press, and
 * the button says it is working the whole time.
 */

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Rig {
  posts: () => { path: string; bearer: string | null; body: unknown }[];
  release: () => void;
}

/** Home, mounted with `/api/auth/anonymous` held open until `release()`. */
function mountHomeBeforeIdentity(): Rig {
  const calls: { path: string; bearer: string | null; body: unknown }[] = [];
  const gates: (() => void)[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      path: `${init?.method ?? 'GET'} ${url.pathname}`,
      bearer: headers.authorization?.replace(/^Bearer /, '') ?? null,
      // The visit beacon posts a Blob; only JSON bodies are of interest here.
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });

    if (url.pathname === '/api/auth/anonymous') {
      await new Promise<void>((resolve) => gates.push(resolve));
      return json({ token: 'bearer-1', participant: ANONYMOUS });
    }
    if (url.pathname === '/api/sessions' && init?.method === 'POST')
      return json({ session: SESSION, state: roomState(1, { sessionId: SESSION.id }) });
    if (url.pathname === '/api/sessions') return json({ sessions: [] });
    if (url.pathname === '/api/experts') return json({ experts: [] });
    if (url.pathname === '/api/me/usage') return json(USAGE);
    if (url.pathname === '/api/me/lists')
      return json({
        savedIds: [],
        likedIds: [],
        counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
      });
    return json({});
  }) as typeof fetch;

  // No `pen.token`: this is a first visit, which is the whole point.
  const platform = testPlatform(memoryStorage());
  render(
    <AppProvider platform={platform}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/room/:id" element={<div>in the room</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AppProvider>,
  );

  return {
    posts: () => calls.filter((c) => c.path === 'POST /api/sessions'),
    release: () => {
      for (const g of gates.splice(0)) g();
    },
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
  hostId: ANONYMOUS.id,
  hostName: ANONYMOUS.name,
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
const USAGE = { plan: 'free', canStart: true, used: 0, limit: 3, resetsAt: 0 };

afterEach(() => {
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('Start, pressed before there is a bearer', () => {
  it('starts the session on the first press, once identity arrives', async () => {
    const rig = mountHomeBeforeIdentity();

    const box = await screen.findByLabelText('What do you want to learn?');
    fireEvent.change(box, { target: { value: 'How Transformers work in LLMs' } });
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));

    // Still inside the window: the press is accepted and said so, not dropped.
    await waitFor(() => expect(screen.getByRole('button', { name: /Starting/ })).toBeTruthy());
    expect(rig.posts(), 'nothing can be created without a bearer').toHaveLength(0);
    expect(screen.queryByText('Connecting to Pen Playground…')).toBeNull();

    rig.release();

    await waitFor(() => expect(screen.getByText('in the room')).toBeTruthy());
    const posts = rig.posts();
    expect(posts, 'one press, one session').toHaveLength(1);
    expect(posts[0]?.bearer, 'created as somebody').toBe('bearer-1');
    expect(posts[0]?.body).toMatchObject({ topic: 'How Transformers work in LLMs' });
  });

  it('a second press inside the window does not create a second session', async () => {
    const rig = mountHomeBeforeIdentity();

    const box = await screen.findByLabelText('What do you want to learn?');
    fireEvent.change(box, { target: { value: 'How Transformers work in LLMs' } });
    const button = screen.getByRole('button', { name: /^Start/ });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();

    rig.release();
    await waitFor(() => expect(screen.getByText('in the room')).toBeTruthy());
    expect(rig.posts(), 'three presses, one session').toHaveLength(1);
  });
});
