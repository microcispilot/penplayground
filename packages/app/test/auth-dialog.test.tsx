import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../src/components/AppHeader.js';
import { AuthDialog } from '../src/components/AuthDialog.js';
import { ANONYMOUS, renderWithApp, SIGNED_IN } from './harness.js';

/**
 * The sign-in sheet (ADR-0040): two doors in the header, one dialog, and
 * what it says when a step fails.
 *
 * The failure copy is held here because it went wrong once: the client names
 * an error by the server's code when the server sent no sentence, and the
 * sheet printed that name — `MAIL_UNAVAILABLE` under the password box, in
 * the error red, to a person who had just asked to create an account.
 */
afterEach(cleanup);

/** Answer the auth routes the way the API does when it cannot; everything else as the harness does. */
function failAuth(answers: Record<string, { status: number; body: unknown }>) {
  const through = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
    const scripted = answers[url.pathname];
    if (scripted) {
      return new Response(JSON.stringify(scripted.body), {
        status: scripted.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return through(input, init);
  }) as typeof fetch;
}

async function reachThePasswordStep() {
  const email = await waitFor(() => screen.getByTestId('auth-email'));
  fireEvent.change(email, { target: { value: 'visitor@example.com' } });
  fireEvent.click(screen.getByTestId('auth-continue'));
  await waitFor(() =>
    expect(screen.getByTestId('auth-email-shown').textContent).toBe('visitor@example.com'),
  );
}

describe('the sign-in sheet', () => {
  it('opens from either door in the header', async () => {
    renderWithApp(<AppHeader />, { participant: ANONYMOUS });
    const signIn = await waitFor(() => screen.getByTestId('account-chip'));
    const signUp = screen.getByTestId('sign-up-cta');
    expect(signIn.textContent).toBe('Sign in');
    expect(signUp.textContent).toBe('Sign up for free');
    // The sheet is a native <dialog>: in the tree, closed until asked for.
    const sheet = screen.getByTestId('auth-form').closest('dialog');
    expect(sheet?.open).toBe(false);

    fireEvent.click(signUp);
    await waitFor(() => expect(sheet?.open).toBe(true));
    // Google is not configured in the harness; the address and Continue are the way in.
    expect(screen.queryByTestId('auth-google')).toBeNull();
    expect(screen.getByTestId('auth-continue').textContent).toBe('Continue');
    // Nothing on the first step asks for a password.
    expect(screen.queryByTestId('auth-password')).toBeNull();
  });

  it('says why a code could not be sent, in a sentence, and offers the other door', async () => {
    const onClose = vi.fn();
    renderWithApp(<AuthDialog open onClose={onClose} />, { participant: ANONYMOUS });
    failAuth({
      '/api/auth/register/start': { status: 503, body: { error: 'MAIL_UNAVAILABLE' } },
    });
    await reachThePasswordStep();

    fireEvent.click(screen.getByTestId('auth-to-signup'));
    const problem = await waitFor(() => screen.getByTestId('auth-problem'));
    expect(problem.textContent).toBe(
      'We can’t send email right now. Try again in a few minutes, or continue with Google.',
    );
    expect(problem.textContent).not.toContain('MAIL_UNAVAILABLE');
    // Still on the password step, with the address kept: nothing typed is lost.
    expect(screen.getByTestId('auth-email-shown').textContent).toBe('visitor@example.com');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('repeats the server’s own sentence when it wrote one, and never a bare code', async () => {
    renderWithApp(<AuthDialog open onClose={() => undefined} />, { participant: ANONYMOUS });
    failAuth({
      '/api/auth/login': {
        status: 401,
        body: { error: 'BAD_CREDENTIALS', message: 'That email and password do not match.' },
      },
      '/api/auth/password/forgot': { status: 429, body: { error: 'RATE_LIMITED' } },
    });
    await reachThePasswordStep();

    fireEvent.change(screen.getByTestId('auth-password'), { target: { value: 'not-the-one' } });
    fireEvent.click(screen.getByTestId('auth-continue'));
    await waitFor(() =>
      expect(screen.getByTestId('auth-problem').textContent).toBe(
        'That email and password do not match.',
      ),
    );

    fireEvent.click(screen.getByTestId('auth-to-forgot'));
    await waitFor(() =>
      expect(screen.getByTestId('auth-problem').textContent).toBe(
        'Too many tries. Give it a minute, then try again.',
      ),
    );
  });
});

/**
 * The app's own Continue with Google (ADR-0042): a real button the sheet
 * draws, Google's popup behind it, and the code it returns sent to the API.
 * GIS is stubbed on `window.google` — the script never loads here — and the
 * request the API receives is what is held.
 */
describe('Continue with Google', () => {
  type CodeConfig = {
    callback: (r: { code?: string }) => void;
    error_callback?: (e: { type: string }) => void;
    client_id: string;
    scope: string;
    ux_mode: string;
  };
  let configs: CodeConfig[];
  let requested: number;
  beforeEach(() => {
    configs = [];
    requested = 0;
    (window as { google?: unknown }).google = {
      accounts: {
        id: { disableAutoSelect: () => undefined },
        oauth2: {
          initCodeClient: (config: CodeConfig) => {
            configs.push(config);
            return {
              requestCode: () => {
                requested += 1;
              },
            };
          },
        },
      },
    };
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'google');
  });

  it('is the sheet’s own button, and the popup’s code is what the API receives', async () => {
    const posts: unknown[] = [];
    const through = globalThis.fetch;
    renderWithApp(<AuthDialog open onClose={() => undefined} />, {
      participant: ANONYMOUS,
      platform: { googleClientId: '123.apps.googleusercontent.com' },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://api.test');
      if (url.pathname === '/api/identity/google') {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ token: 'account-token', participant: SIGNED_IN, outcome: 'linked' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return through(input, init);
    }) as typeof fetch;

    const button = await waitFor(() => screen.getByTestId('auth-google'));
    // Ours: a button in the sheet's own type, not a slot for an iframe.
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toContain('Continue with Google');
    expect(button.querySelector('iframe')).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(requested).toBe(1));
    expect(configs[0]).toMatchObject({
      client_id: '123.apps.googleusercontent.com',
      ux_mode: 'popup',
      scope: 'openid email profile',
    });

    configs[0]?.callback({ code: '4/0AbCdEfGhIjKlMnOpQrStUvWxYz' });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ code: '4/0AbCdEfGhIjKlMnOpQrStUvWxYz' });
  });

  it('says nothing when the person closes Google’s window, and is ready again', async () => {
    renderWithApp(<AuthDialog open onClose={() => undefined} />, {
      participant: ANONYMOUS,
      platform: { googleClientId: '123.apps.googleusercontent.com' },
    });
    const button = await waitFor(() => screen.getByTestId('auth-google'));
    fireEvent.click(button);
    await waitFor(() => expect(configs).toHaveLength(1));
    configs[0]?.error_callback?.({ type: 'popup_closed' });
    await waitFor(() =>
      expect((screen.getByTestId('auth-google') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByRole('alert')).toBeNull();

    // A blocked popup is worth a sentence.
    fireEvent.click(screen.getByTestId('auth-google'));
    await waitFor(() => expect(configs).toHaveLength(2));
    configs[1]?.error_callback?.({ type: 'popup_failed_to_open' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Allow pop-ups'));
  });
});
