import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The heavy screens are stubbed: this is a test of the route table and the
 * split, not of the room. Stubbing them also keeps the lazy chunks resolvable
 * in happy-dom, where tldraw and the audio graph have nothing to run on.
 */
const { preloadBoard } = vi.hoisted(() => ({ preloadBoard: vi.fn() }));
vi.mock('../src/components/BoardSurface.js', () => ({
  preloadBoard,
  BoardSurface: () => null,
}));
vi.mock('../src/screens/Room.js', () => ({
  Room: () => <div data-testid="room-screen">room</div>,
}));
vi.mock('../src/screens/Replay.js', () => ({
  Replay: () => <div data-testid="replay-screen">replay</div>,
}));
vi.mock('../src/screens/SessionPage.js', () => ({
  SessionPage: () => <div data-testid="session-screen">session</div>,
}));

import { PenApp } from '../src/App.js';
import { useLists } from '../src/lib/lists.js';
import { memoryStorage, testPlatform } from './harness.js';

/** Enough of the API for the shell to boot: a participant and empty lists. */
function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    const answers: Record<string, unknown> = {
      '/api/me': {
        participant: {
          id: 'p_anonymous_0001',
          name: 'Learner',
          plan: 'free',
          anonymous: true,
          email: null,
          avatarUrl: null,
        },
      },
      '/api/me/lists': {
        savedIds: [],
        likedIds: [],
        counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
      },
      '/api/sessions': { sessions: [] },
      '/api/experts': { experts: [] },
    };
    const body = answers[url.pathname];
    return new Response(JSON.stringify(body ?? { error: 'NOT_FOUND' }), {
      status: body === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function renderAt(path: string) {
  window.history.replaceState({}, '', path);
  const storage = memoryStorage({ 'pen.token': 'test-token' });
  return render(<PenApp platform={testPlatform(storage)} />);
}

beforeEach(() => {
  useLists.getState().reset();
  stubFetch();
});

afterEach(() => {
  // No `globals: true`, so React Testing Library's automatic cleanup never registers.
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('the route table', () => {
  it('puts the shell around Home', async () => {
    renderAt('/');
    await waitFor(() => expect(screen.getByTestId('sidebar-aside')).toBeTruthy());
  });

  it('keeps the shell off the room and the replay, and starts the board chunk with theirs', async () => {
    // The board (tldraw + the ink engine) is far heavier than either route
    // chunk, so requesting one must put the other in flight at the same time.
    // `lazy()` runs its loader once per module, so this is asserted on the
    // first render of each route in this file.
    const room = renderAt('/room/s_123');
    expect(screen.getByTestId('route-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('room-screen')).toBeTruthy());
    expect(preloadBoard).toHaveBeenCalled();
    expect(screen.queryByTestId('sidebar-aside')).toBeNull();
    expect(screen.queryByTestId('sidebar')).toBeNull();
    expect(screen.queryByTestId('sidebar-menu')).toBeNull();
    room.unmount();

    preloadBoard.mockClear();
    const replay = renderAt('/replay/s_123');
    await waitFor(() => expect(screen.getByTestId('replay-screen')).toBeTruthy());
    expect(preloadBoard).toHaveBeenCalled();
    expect(screen.queryByTestId('sidebar-aside')).toBeNull();
    replay.unmount();
  });

  it('splits the room, the replay and the session page into their own chunks', async () => {
    // Before the chunk resolves there is a calm fallback, never a blank frame.
    renderAt('/sessions/s_123');
    expect(screen.getByTestId('route-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('session-screen')).toBeTruthy());
    expect(screen.queryByTestId('route-loading')).toBeNull();
    // It is still a shell screen: the sidebar is around it.
    expect(screen.getByTestId('sidebar-aside')).toBeTruthy();
  });

  it('answers an unknown path with the 404 screen, inside the shell', async () => {
    renderAt('/nope');
    await waitFor(() => expect(screen.getByText('This page wandered off')).toBeTruthy());
    expect(screen.getByTestId('sidebar-aside')).toBeTruthy();
  });
});
