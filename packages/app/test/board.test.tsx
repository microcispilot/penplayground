import { BOARD_PREFERENCE_DEFAULT } from '@pen/contracts';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOARD_PREFERENCE_KEY,
  readBoardPreference,
  resetBoardPreferenceForTests,
  writeBoardPreference,
} from '../src/lib/board-preference.js';
import { Settings } from '../src/screens/Settings.js';
import { ANONYMOUS, memoryStorage, renderWithApp, SIGNED_IN } from './harness.js';

afterEach(cleanup);
beforeEach(() => {
  resetBoardPreferenceForTests();
  document.documentElement.removeAttribute('data-board');
  document.documentElement.removeAttribute('data-ink');
});

/**
 * The board a learner chooses, from storage through to the attributes the
 * whole product paints from.
 *
 * The rule under test is the owner's and it has two halves: **choosing is the
 * paid act**, so a free learner gets the default and nothing else; and **a
 * chalk cannot go on a marker board**, so the colours on offer change with the
 * surface rather than being greyed out.
 */
describe('the stored preference', () => {
  it('returns the default for empty, corrupt, and foreign-vocabulary storage', () => {
    expect(readBoardPreference(memoryStorage())).toEqual(BOARD_PREFERENCE_DEFAULT);
    expect(readBoardPreference(memoryStorage({ [BOARD_PREFERENCE_KEY]: 'not json' }))).toEqual(
      BOARD_PREFERENCE_DEFAULT,
    );
    // A build that had a board this one does not.
    expect(
      readBoardPreference(
        memoryStorage({
          [BOARD_PREFERENCE_KEY]: JSON.stringify({
            surface: 'holographic',
            marker: 'x',
            chalk: 'y',
          }),
        }),
      ),
    ).toEqual(BOARD_PREFERENCE_DEFAULT);
  });

  it('round-trips a whole choice, because the three values are one decision', () => {
    const storage = memoryStorage();
    const chosen = { surface: 'greenboard', marker: 'marker-red', chalk: 'chalk-yellow' } as const;
    writeBoardPreference(storage, chosen);
    expect(readBoardPreference(storage)).toEqual(chosen);
  });

  it('does not consult the plan, so a lapsed subscriber gets their board back', () => {
    // Storage holds what the learner picked; `resolveSurface` decides what they
    // may have today. Erasing it on downgrade would lose the choice for good.
    const storage = memoryStorage();
    writeBoardPreference(storage, {
      surface: 'smoked',
      marker: 'marker-black',
      chalk: 'chalk-blue',
    });
    expect(readBoardPreference(storage).surface).toBe('smoked');
  });
});

/**
 * The participant arrives from `/api/me` a tick after first paint, so every
 * render starts on the free plan and upgrades. Interacting before that lands
 * clicks a Pricing link instead of a control — which is correct behaviour and
 * a broken test, so the paid state is waited for rather than assumed.
 */
async function paidBoardsReady(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId(`board-${id}`).tagName).toBe('BUTTON'));
  return screen.getByTestId(`board-${id}`);
}

describe('the picker', () => {
  it('shows a free learner the plan a board belongs to, and links it to Pricing', async () => {
    renderWithApp(<Settings />, { participant: ANONYMOUS });
    // `auto` is the one surface a free learner may select, so it is a button.
    const auto = await screen.findByTestId('board-auto');
    expect(auto.tagName).toBe('BUTTON');
    // Everything else is a link to Pricing, not a dead control.
    for (const id of ['whiteboard', 'blackboard', 'greenboard', 'ivory', 'smoked']) {
      const card = screen.getByTestId(`board-${id}`);
      expect(card.tagName, `${id} should route a free learner to Pricing`).toBe('A');
      expect(card.getAttribute('href')).toContain('/pricing');
    }
    // Calm: a plan's name, never a padlock and never "locked".
    expect(screen.queryByText(/locked|upgrade required/i)).toBeNull();
    expect(screen.getAllByText('Standard').length).toBeGreaterThan(0);
  });

  it('offers a paying learner the boards their plan covers as real controls', async () => {
    // SIGNED_IN is on `standard`.
    renderWithApp(<Settings />, { participant: SIGNED_IN });
    await paidBoardsReady('greenboard');
    for (const id of ['auto', 'whiteboard', 'blackboard', 'greenboard', 'ivory']) {
      expect(screen.getByTestId(`board-${id}`).tagName, id).toBe('BUTTON');
    }
    // Smoked is Professional, and still just carries its plan's name.
    const smoked = screen.getByTestId('board-smoked');
    expect(smoked.tagName).toBe('A');
    expect(screen.getByText('Professional')).toBeTruthy();
  });

  /**
   * The compatibility rule, as the learner meets it. A chalk on a whiteboard
   * is not a disabled option — it is not an option, so it is not rendered.
   */
  it('offers markers on a marker board and chalks on a chalk board, never both', async () => {
    const storage = memoryStorage();
    writeBoardPreference(storage, {
      surface: 'whiteboard',
      marker: 'marker-black',
      chalk: 'chalk-white',
    });
    renderWithApp(<Settings />, { participant: SIGNED_IN, storage });
    await paidBoardsReady('blackboard');

    expect(screen.getByTestId('ink-marker-black')).toBeTruthy();
    expect(screen.getByTestId('ink-marker-red')).toBeTruthy();
    expect(screen.queryByTestId('ink-chalk-white')).toBeNull();
    expect(screen.queryByTestId('ink-chalk-yellow')).toBeNull();

    // Move to a chalk board and the whole set swaps.
    fireEvent.click(screen.getByTestId('board-blackboard'));
    expect(await screen.findByTestId('ink-chalk-white')).toBeTruthy();
    expect(screen.queryByTestId('ink-marker-black')).toBeNull();
  });

  it('keeps the other kind’s colour when the board changes and changes back', async () => {
    const storage = memoryStorage();
    writeBoardPreference(storage, {
      surface: 'whiteboard',
      marker: 'marker-black',
      chalk: 'chalk-white',
    });
    renderWithApp(<Settings />, { participant: SIGNED_IN, storage });
    await paidBoardsReady('blackboard');

    fireEvent.click(screen.getByTestId('ink-marker-red'));
    fireEvent.click(screen.getByTestId('board-blackboard'));
    fireEvent.click(await screen.findByTestId('ink-chalk-pink'));
    fireEvent.click(screen.getByTestId('board-whiteboard'));

    // The marker survived the round trip: this is why the preference keeps one
    // colour per kind rather than a single "ink".
    const saved = readBoardPreference(storage);
    expect(saved.marker).toBe('marker-red');
    expect(saved.chalk).toBe('chalk-pink');
  });

  it('paints the document with what was chosen', async () => {
    const storage = memoryStorage();
    renderWithApp(<Settings />, { participant: SIGNED_IN, storage });
    fireEvent.click(await paidBoardsReady('greenboard'));
    // The attributes are what every board token keys off; without them the
    // choice is stored and invisible.
    expect(document.documentElement.getAttribute('data-board')).toBe('greenboard');
    expect(document.documentElement.getAttribute('data-ink')).toBe('chalk-white');
  });
});
