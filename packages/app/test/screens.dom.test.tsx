// @vitest-environment happy-dom

import { ToastProvider } from '@pen/design';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React 19 wants to know it is running inside a test so `act` is honoured.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { AppErrorBoundary, ErrorScreen } from '../src/components/AppErrorBoundary.js';
import { resetAnalyticsForTests } from '../src/lib/analytics.js';
import { applySeo, pageTitle, seoForPath } from '../src/lib/seo.js';
import { NotFound } from '../src/screens/NotFound.js';

/**
 * The two screens a learner should never need but must be able to trust: the
 * 404 and the fallback for a render crash. Rendered for real (happy-dom) so
 * the copy, the controls and the Monitor report are what ships.
 */
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetAnalyticsForTests();
  document.head.innerHTML = '';
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

/** The app context the 404 needs; no network, no platform APIs. */
vi.mock('../src/lib/context.js', () => ({
  useApp: () => ({
    api: {
      createSession: vi.fn(async () => ({ session: { id: 's_new_0001' } })),
      portraitUrl: () => null,
    },
    participant: { id: 'p_1', name: 'Sam', plan: 'free', anonymous: true },
    platform: {
      name: 'web',
      googleClientId: null,
      storage: { get: () => null, set: () => undefined, remove: () => undefined },
      openExternal: () => undefined,
    },
    setName: async () => undefined,
    signInWithGoogle: async () => 'created',
    signOut: async () => undefined,
    authError: null,
  }),
}));

describe('the 404 screen', () => {
  it('says what happened without alarm and offers a way on', () => {
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/nope']}>
          <NotFound />
        </MemoryRouter>
      </ToastProvider>,
    );
    const text = host.textContent ?? '';
    expect(text).toContain('This page wandered off');
    expect(text).toContain('The link may be old, or the session was private.');
    // Nothing that reads as a fault: no "error", no code, no apology.
    expect(text.toLowerCase()).not.toContain('error');
    expect(text).toContain('Explore sessions');
    expect(text).toContain('My sessions');
    // The Pen mark, and a box that starts a session.
    expect(host.querySelector('svg')).not.toBeNull();
    const field = host.querySelector<HTMLInputElement>(
      'input[aria-label="What do you want to learn?"]',
    );
    expect(field).not.toBeNull();
    expect(host.querySelector('form')).not.toBeNull();
    // Start is disabled until there is a topic.
    const start = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Start'),
    );
    expect(start?.disabled).toBe(true);
  });

  it('keeps itself out of the index', () => {
    applySeo(seoForPath('/definitely-not-a-page'));
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, follow',
    );
    expect(document.title).toBe('Page not found · Pen Playground');
  });
});

describe('the error boundary', () => {
  const Boom = (): ReactNode => {
    throw new Error('PEN_TEST_RENDER_CRASH');
  };

  it('catches a render crash, reports it to the Monitor seam and shows the reference', () => {
    const onError = vi.fn(() => 'sentry-event-id-1');
    // React logs the caught error; the test is about what the learner sees.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary onError={onError}>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Error);
    const text = host.textContent ?? '';
    expect(text).toContain('This screen stopped drawing');
    expect(text).toContain('your sessions are safe');
    expect(host.querySelector('[data-testid="error-reference"]')?.textContent).toBe(
      'sentry-event-id-1',
    );
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Try again',
      'Back to Explore',
    ]);
    consoleError.mockRestore();
  });

  it('renders the children again when the learner tries again', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    const Maybe = (): ReactNode => {
      if (broken) throw new Error('PEN_TEST_RENDER_CRASH');
      return <p>recovered</p>;
    };
    render(
      <AppErrorBoundary onError={() => null}>
        <Maybe />
      </AppErrorBoundary>,
    );
    expect(host.querySelector('[data-testid="error-screen"]')).not.toBeNull();
    // No reference to show when no monitor is configured; the screen still works.
    expect(host.querySelector('[data-testid="error-reference"]')).toBeNull();
    broken = false;
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    act(() => retry?.click());
    expect(host.textContent).toContain('recovered');
    expect(host.querySelector('[data-testid="error-screen"]')).toBeNull();
    consoleError.mockRestore();
  });

  it('shows the fallback even when reporting itself fails', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary
        onError={() => {
          throw new Error('monitor is down');
        }}
      >
        <Boom />
      </AppErrorBoundary>,
    );
    expect(host.textContent).toContain('This screen stopped drawing');
    consoleError.mockRestore();
  });

  it('lets a page be looked at on its own', () => {
    render(<ErrorScreen reference={null} onRetry={() => undefined} />);
    expect(host.querySelector('[data-testid="error-screen"]')).not.toBeNull();
  });
});

describe('page titles', () => {
  it('name the thing first and the site once', () => {
    expect(pageTitle('Pricing')).toBe('Pricing · Pen Playground');
    expect(pageTitle('Pen Playground')).toBe('Pen Playground');
    expect(pageTitle('  ')).toBe('Pen Playground');
    expect(pageTitle('A session · Pen Playground')).toBe('A session · Pen Playground');
  });

  it('keep rooms and replays out of search, and leave public pages in', () => {
    expect(seoForPath('/room/s_1').noindex).toBe(true);
    expect(seoForPath('/replay/s_1').noindex).toBe(true);
    expect(seoForPath('/sessions').noindex).toBe(true);
    expect(seoForPath('/').noindex).toBeUndefined();
    expect(seoForPath('/pricing').noindex).toBeUndefined();
    expect(seoForPath('/sessions/s_1').noindex).toBeUndefined();
  });

  it('write one canonical link and one description, however often a screen re-renders', () => {
    applySeo({ title: 'One', description: 'first' });
    applySeo({ title: 'Two', description: 'second' });
    expect(document.querySelectorAll('link[rel="canonical"]').length).toBe(1);
    expect(document.querySelectorAll('meta[name="description"]').length).toBe(1);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'second',
    );
    expect(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')).toBe(
      'Pen Playground',
    );
    // The robots tag is removed again once a page belongs in the index.
    applySeo({ title: 'Three', noindex: true });
    expect(document.querySelector('meta[name="robots"]')).not.toBeNull();
    applySeo({ title: 'Four' });
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
});
