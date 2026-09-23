import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Home } from '../src/screens/Home.js';
import { ANONYMOUS, renderWithApp } from './harness.js';

/**
 * What Home says when the day's allowance is spent.
 *
 * It used to end the sentence with an inline underlined link reading
 * "Standard makes them unlimited" — which names a product rather than the next
 * step, and asks a learner to recognise a plan before they can tell it is the
 * way forward. The owner asked for the opposite: *"it should say something
 * like upgrade to continue. And the upgrade should have a link to the
 * subscriptions page."*
 *
 * So the fact stays in the ordinary voice and the way out is a button under
 * it, pointing at `/pricing`. Three things are held here, and each is a way
 * this has been got wrong before:
 *
 *   · the banner only exists while something is actually in the way — a
 *     running count nobody asked for is the thing it replaced;
 *   · the action is a real link to the subscriptions page, not a button that
 *     opens a dialog or a `<button>` a middle-click cannot open in a tab;
 *   · none of it is painted in the error role. Reaching a limit is an
 *     ordinary state, and `#ED424A` here would make a normal Tuesday look
 *     like a fault.
 */

// This package has no global setup file: every render test unmounts its own.
// Without it `screen` keeps finding the previous test's banner, and the second
// case passes or fails on the first case's DOM.
afterEach(cleanup);

/** Everything Home asks for on load, with the allowance the test is about. */
const routes = (usage: Record<string, unknown>) => ({
  '/api/experts': { experts: [] },
  '/api/sessions': { sessions: [] },
  '/api/me/usage': {
    plan: 'free',
    sessionsToday: 3,
    sessionsPerDay: 3,
    remaining: 0,
    maxSessionMinutes: 20,
    resetsAt: 0,
    canStart: false,
    reason: 'daily_limit',
    ...usage,
  },
});

describe('the allowance banner', () => {
  it('offers "Upgrade to continue", linked to the subscriptions page', async () => {
    renderWithApp(<Home />, { participant: ANONYMOUS, routes: routes({}) });

    const banner = await waitFor(() => screen.getByTestId('home-allowance'));
    // The fact, in the ordinary voice, with no plan named in it.
    expect(banner.textContent).toContain('3 sessions for today');
    expect(banner.textContent).toContain('midnight UTC');

    const upgrade = screen.getByTestId('home-upgrade');
    expect(upgrade.textContent).toContain('Upgrade to continue');
    // A real anchor to Pricing: openable in a tab, crawlable, not a handler.
    expect(upgrade.tagName).toBe('A');
    expect(upgrade.getAttribute('href')).toContain('/pricing');

    // The old inline link is gone, and so is naming the plan here.
    expect(banner.textContent).not.toContain('makes them unlimited');
    expect(banner.textContent).not.toContain('Standard');
  });

  it('says the day is booked out when it is capacity rather than the count', async () => {
    renderWithApp(<Home />, {
      participant: ANONYMOUS,
      routes: routes({ reason: 'capacity', remaining: null }),
    });
    const banner = await waitFor(() => screen.getByTestId('home-allowance'));
    expect(banner.textContent).toContain('all booked for today');
    // Upgrading is still the way through: a paid plan is not held by the cap.
    expect(screen.getByTestId('home-upgrade').getAttribute('href')).toContain('/pricing');
  });

  it('is silent while the learner can still start something', async () => {
    renderWithApp(<Home />, {
      participant: ANONYMOUS,
      routes: routes({ canStart: true, reason: null, remaining: 2 }),
    });
    await waitFor(() => expect(screen.getByLabelText('What do you want to learn?')).toBeTruthy());
    expect(screen.queryByTestId('home-allowance')).toBeNull();
    expect(screen.queryByTestId('home-upgrade')).toBeNull();
  });

  it('never paints a limit in the error role', async () => {
    renderWithApp(<Home />, { participant: ANONYMOUS, routes: routes({}) });
    const banner = await waitFor(() => screen.getByTestId('home-allowance'));
    // The brand red is right here — it is Start's fill and Sign in's. The
    // error ladder is not: nothing has broken.
    expect(banner.innerHTML).not.toMatch(/\berror\b/);
    expect(banner.querySelector('[data-testid="home-upgrade"]')?.className).toContain(
      'bg-primary-fixed',
    );
  });
});
