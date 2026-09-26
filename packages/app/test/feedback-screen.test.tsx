import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Feedback } from '../src/screens/Feedback.js';
import { ANONYMOUS, renderWithApp, SIGNED_IN } from './harness.js';

afterEach(cleanup);

const sentOk = { 'POST /api/feedback': { feedback: { id: 'f_1', kind: 'issue', createdAt: 1 } } };

/**
 * Feedback and support (ADR-0060): four kinds, one message, an address only
 * when there is none to reply to, and the words never in an event.
 */
describe('the feedback page', () => {
  it('offers the four kinds and starts on the one the link named', async () => {
    renderWithApp(<Feedback />, {
      participant: SIGNED_IN,
      route: '/feedback?kind=feature',
      routes: sentOk,
    });
    await screen.findByRole('heading', { level: 2, name: 'Feedback and support' });
    for (const label of [
      'Report an issue',
      'Suggest an improvement',
      'Request a feature',
      'Contact us',
    ])
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeTruthy();
    expect((screen.getByTestId('feedback-kind-feature') as HTMLInputElement).checked).toBe(true);
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it('a signed-in learner needs no address, a visitor does, and contact always asks', async () => {
    const { calls } = renderWithApp(<Feedback />, {
      participant: SIGNED_IN,
      route: '/feedback',
      routes: sentOk,
    });
    await screen.findByTestId('feedback-message');
    expect(screen.queryByTestId('feedback-email')).toBeNull();
    expect(document.body.textContent).toContain('ada@example.com');
    const send = screen.getByTestId('feedback-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('feedback-message'), {
      target: { value: 'The board stopped drawing after the second segment.' },
    });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await screen.findByTestId('feedback-sent');
    expect(calls).toContain('POST /api/feedback');
    // Contact asks where to reply even with an account, prefilled from it.
    cleanup();
    renderWithApp(<Feedback />, {
      participant: SIGNED_IN,
      route: '/feedback?kind=contact',
      routes: sentOk,
    });
    const email = (await screen.findByTestId('feedback-email')) as HTMLInputElement;
    expect(email.value).toBe('ada@example.com');
    cleanup();
    renderWithApp(<Feedback />, { participant: ANONYMOUS, route: '/feedback', routes: sentOk });
    const visitorEmail = (await screen.findByTestId('feedback-email')) as HTMLInputElement;
    expect(visitorEmail.value).toBe('');
  });

  it('says what went wrong when the server declines, and keeps the words', async () => {
    renderWithApp(<Feedback />, {
      participant: SIGNED_IN,
      route: '/feedback',
      routes: {
        'POST /api/feedback': {
          __status: 429,
          error: 'RATE_LIMITED',
          message:
            'You have sent everything we can take in one day. Thank you, and please continue tomorrow.',
        },
      },
    });
    const box = (await screen.findByTestId('feedback-message')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'A message long enough to send today.' } });
    const send = screen.getByTestId('feedback-send') as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('continue tomorrow');
    expect(box.value).toBe('A message long enough to send today.');
  });
});
