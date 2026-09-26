import { SURVEY_OPTIONS } from '@pen/contracts';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurveyDialog, SurveyPrompt } from '../src/components/SurveyDialog.js';
import { renderWithApp, SIGNED_IN } from './harness.js';

afterEach(cleanup);

/**
 * One question, one list, one step (ADR-0060), with Skip always a press away.
 */
describe('the survey dialog', () => {
  it('lists every option, takes one, and records it', async () => {
    const done = vi.fn();
    const { calls } = renderWithApp(
      <SurveyDialog open kind="signup_source" trigger="checkout" onDone={done} />,
      { participant: SIGNED_IN, routes: { 'POST /api/me/surveys': { ok: true } } },
    );
    await screen.findByText('How did you hear about Pen Playground?');
    for (const o of SURVEY_OPTIONS.signup_source)
      expect(screen.getByTestId(`survey-option-${o.id}`)).toBeTruthy();
    const go = screen.getByTestId('survey-continue') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('survey-option-youtube'));
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(calls).toContain('POST /api/me/surveys');
  });

  it('"Other" asks for a few words before it continues; Skip needs nothing', async () => {
    const done = vi.fn();
    renderWithApp(
      <SurveyDialog open kind="cancel_reason" trigger="account_deleted" onDone={done} />,
      {
        participant: SIGNED_IN,
        routes: { 'POST /api/me/surveys': { ok: true } },
      },
    );
    await screen.findByText('What made you decide to leave?');
    fireEvent.click(screen.getByTestId('survey-option-other'));
    const go = screen.getByTestId('survey-continue') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('survey-other'), {
      target: { value: 'Moving countries for a year' },
    });
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(screen.getByTestId('survey-skip'));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it('lets the learner through even when the answer could not be recorded', async () => {
    const done = vi.fn();
    renderWithApp(<SurveyDialog open kind="signup_source" trigger="checkout" onDone={done} />, {
      participant: SIGNED_IN,
      routes: { 'POST /api/me/surveys': { __status: 500, error: 'INTERNAL' } },
    });
    fireEvent.click(await screen.findByTestId('survey-skip'));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });
});

describe('the shell’s catch-up prompt', () => {
  it('asks only the leaving survey, never the arrival one on a later visit', async () => {
    renderWithApp(<SurveyPrompt />, {
      participant: SIGNED_IN,
      routes: { '/api/me/surveys': { pending: [{ kind: 'signup_source', trigger: 'checkout' }] } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('How did you hear about Pen Playground?')).toBeNull();
    cleanup();
    renderWithApp(<SurveyPrompt />, {
      participant: SIGNED_IN,
      routes: {
        '/api/me/surveys': {
          pending: [
            { kind: 'signup_source', trigger: 'checkout' },
            { kind: 'cancel_reason', trigger: 'subscription_cancelled' },
          ],
        },
      },
    });
    await screen.findByText('What made you decide to leave?');
    expect(screen.queryByText('How did you hear about Pen Playground?')).toBeNull();
  });
});
