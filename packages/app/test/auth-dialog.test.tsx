import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../src/components/AppHeader.js';
import { AuthDialog } from '../src/components/AuthDialog.js';
import { ANONYMOUS, renderWithApp } from './harness.js';

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
