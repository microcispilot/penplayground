import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Account } from '../src/screens/Account.js';
import { renderWithApp, SIGNED_IN } from './harness.js';

afterEach(cleanup);

/**
 * Leaving (ADR-0060): the account is deleted only after the learner has had
 * one question, and one press of Skip is enough to go on.
 */
describe('deleting the account', () => {
  it('asks why first, with a one-press Skip, and then deletes', async () => {
    const { calls } = renderWithApp(<Account />, {
      participant: SIGNED_IN,
      route: '/account',
      routes: {
        'POST /api/me/surveys': { ok: true },
        'DELETE /api/me': { ok: true, sessionsDeleted: 2 },
        'POST /api/auth/anonymous': {
          token: 'fresh-token',
          participant: { ...SIGNED_IN, id: 'p_fresh', anonymous: true, plan: 'free', email: null },
        },
      },
    });
    fireEvent.click(await screen.findByTestId('delete-account'));
    fireEvent.click(await screen.findByTestId('confirm-delete-account'));
    // The question stands between the press and the deletion.
    await screen.findByText('What made you decide to leave?');
    expect(calls).not.toContain('DELETE /api/me');
    fireEvent.click(screen.getByTestId('survey-skip'));
    await waitFor(() => expect(calls).toContain('DELETE /api/me'));
    // The skip was recorded before the account went.
    const skipAt = calls.indexOf('POST /api/me/surveys');
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(calls.indexOf('DELETE /api/me'));
  });
});
