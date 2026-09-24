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
  for (const attr of ['data-board', 'data-ink', 'data-tool'])
    document.documentElement.removeAttribute(attr);
});

const html = () => ({
  board: document.documentElement.getAttribute('data-board'),
  ink: document.documentElement.getAttribute('data-ink'),
  tool: document.documentElement.getAttribute('data-tool'),
});

/**
 * The board a learner chooses, from storage through to the attributes the
 * whole product paints from.
 *
 * The rules under test are the owner's (ADR-0041): **choosing is the paid
 * act**, so a free learner gets the default and nothing else; **the surface,
 * the tool and the colour are three separate choices**, so chalk goes on a
 * whiteboard; and **the one colour refused is the board's own**, disabled in
 * the picker and never painted, without the stored choice being touched.
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
          [BOARD_PREFERENCE_KEY]: JSON.stringify({ surface: 'holographic', tool: 'x', ink: 'y' }),
        }),
      ),
    ).toEqual(BOARD_PREFERENCE_DEFAULT);
  });

  it('round-trips a whole choice, because the three values are one decision', () => {
    const storage = memoryStorage();
    const chosen = { surface: 'greenboard', tool: 'marker', ink: 'red' } as const;
    writeBoardPreference(storage, chosen);
    expect(readBoardPreference(storage)).toEqual(chosen);
  });

  it('reads what a build before ADR-0041 wrote, as the colour that board used', () => {
    // One colour per kind, the kind decided by the board: the blackboard
    // wrote in its chalk colour, so that is the colour that survives.
    const storage = memoryStorage({
      [BOARD_PREFERENCE_KEY]: JSON.stringify({
        surface: 'blackboard',
        marker: 'marker-red',
        chalk: 'chalk-yellow',
      }),
    });
    expect(readBoardPreference(storage)).toEqual({
      surface: 'blackboard',
      tool: 'auto',
      ink: 'yellow',
    });
  });

  it('does not consult the plan, so a lapsed subscriber gets their board back', () => {
    // Storage holds what the learner picked; `resolveSurface` decides what they
    // may have today. Erasing it on downgrade would lose the choice for good.
    const storage = memoryStorage();
    writeBoardPreference(storage, { surface: 'smoked', tool: 'chalk', ink: 'blue' });
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
    // The tool follows the board for free; choosing one is Standard.
    expect(screen.getByTestId('tool-auto').tagName).toBe('BUTTON');
    expect(screen.getByTestId('tool-chalk').tagName).toBe('A');
    expect(screen.getByTestId('tool-marker').tagName).toBe('A');
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
    for (const id of ['auto', 'chalk', 'marker']) {
      expect(screen.getByTestId(`tool-${id}`).tagName, id).toBe('BUTTON');
    }
    // Smoked is Professional, and still just carries its plan's name.
    const smoked = screen.getByTestId('board-smoked');
    expect(smoked.tagName).toBe('A');
    expect(screen.getByText('Professional')).toBeTruthy();
  });

  /**
   * The one rule, as the learner meets it: every colour is on offer on every
   * board, and the board's own colour is disabled — not hidden, not a link.
   */
  it('offers every colour on every board, with the board’s own colour disabled', async () => {
    const storage = memoryStorage();
    writeBoardPreference(storage, { surface: 'whiteboard', tool: 'auto', ink: 'auto' });
    renderWithApp(<Settings />, { participant: SIGNED_IN, storage });
    await paidBoardsReady('blackboard');

    const white = screen.getByTestId('ink-white') as HTMLButtonElement;
    expect(white.tagName).toBe('BUTTON');
    expect(white.disabled).toBe(true);
    expect(white.textContent).toContain('The board’s colour');
    for (const id of ['black', 'red', 'blue', 'green', 'yellow', 'pink']) {
      const dot = screen.getByTestId(`ink-${id}`) as HTMLButtonElement;
      expect(dot.tagName, id).toBe('BUTTON');
      expect(dot.disabled, id).toBe(false);
    }

    // Move to the blackboard and the refusal moves with it.
    fireEvent.click(screen.getByTestId('board-blackboard'));
    await waitFor(() =>
      expect((screen.getByTestId('ink-black') as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByTestId('ink-white') as HTMLButtonElement).disabled).toBe(false);
    // And on the green board it is the green.
    fireEvent.click(screen.getByTestId('board-greenboard'));
    await waitFor(() =>
      expect((screen.getByTestId('ink-green') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getAllByText('The board’s colour')).toHaveLength(1);
  });

  it('puts chalk on a whiteboard, because the tool is not the board’s to decide', async () => {
    const storage = memoryStorage();
    writeBoardPreference(storage, { surface: 'whiteboard', tool: 'auto', ink: 'auto' });
    renderWithApp(<Settings />, { participant: SIGNED_IN, storage });
    await paidBoardsReady('blackboard');
    expect(html().tool).toBe('marker');

    fireEvent.click(screen.getByTestId('tool-chalk'));
    await waitFor(() => expect(html().tool).toBe('chalk'));
    expect(html().board).toBe('whiteboard');
    expect(readBoardPreference(storage).tool).toBe('chalk');

    // Back to following the board, and a dark board brings its own chalk.
    fireEvent.click(screen.getByTestId('tool-auto'));
    await waitFor(() => expect(html().tool).toBe('marker'));
    fireEvent.click(screen.getByTestId('board-smoked'));
    // Smoked is Professional: a Standard learner's click is a link, so nothing changes.
    expect(html().board).toBe('whiteboard');
    fireEvent.click(screen.getByTestId('board-blackboard'));
    await waitFor(() => expect(html().tool).toBe('chalk'));
  });

  it('keeps a colour the current board refuses, and paints it again on the next board that takes it', async () => {
    const storage = memoryStorage();
    writeBoardPreference(storage, { surface: 'blackboard', tool: 'auto', ink: 'auto' });
    renderWithApp(<Settings />, { participant: SIGNED_IN, storage });
    await paidBoardsReady('whiteboard');

    fireEvent.click(screen.getByTestId('ink-white'));
    await waitFor(() => expect(html().ink).toBe('white'));
    fireEvent.click(screen.getByTestId('board-whiteboard'));
    // White cannot be written on the whiteboard, so the board's own default is painted…
    await waitFor(() => expect(html().ink).toBe('black'));
    // …and the choice is still there, untouched.
    expect(readBoardPreference(storage).ink).toBe('white');
    fireEvent.click(screen.getByTestId('board-greenboard'));
    await waitFor(() => expect(html().ink).toBe('white'));
  });

  it('paints the document with what was chosen', async () => {
    const storage = memoryStorage();
    renderWithApp(<Settings />, { participant: SIGNED_IN, storage });
    fireEvent.click(await paidBoardsReady('greenboard'));
    // The attributes are what every board token keys off; without them the
    // choice is stored and invisible.
    await waitFor(() =>
      expect(html()).toEqual({ board: 'greenboard', ink: 'white', tool: 'chalk' }),
    );
    fireEvent.click(screen.getByTestId('ink-yellow'));
    fireEvent.click(screen.getByTestId('tool-marker'));
    await waitFor(() =>
      expect(html()).toEqual({ board: 'greenboard', ink: 'yellow', tool: 'marker' }),
    );
  });
});

/**
 * Device-first, but not device-only.
 *
 * The account copy exists so a green board set on a laptop turns up on a
 * phone. The dangerous half is the other direction: adopting the account's
 * board on a machine that already has one would overwrite a choice the learner
 * made seconds ago, on the screen they are looking at. The guard is that the
 * raw storage key must be absent — "read returned the default" is not the same
 * as "the learner never chose", and only the key can tell the two apart.
 */
describe('the account copy', () => {
  const withBoard = {
    ...SIGNED_IN,
    board: { surface: 'greenboard', tool: 'marker', ink: 'pink' },
  } as const;

  it('fills in on a machine that has never chosen', async () => {
    const storage = memoryStorage();
    renderWithApp(<Settings />, { participant: withBoard, storage });
    await waitFor(() => expect(readBoardPreference(storage).surface).toBe('greenboard'));
    expect(readBoardPreference(storage).ink).toBe('pink');
    expect(readBoardPreference(storage).tool).toBe('marker');
  });

  it('never overwrites a choice this device already holds', async () => {
    const storage = memoryStorage();
    writeBoardPreference(storage, { surface: 'ivory', tool: 'auto', ink: 'blue' });
    renderWithApp(<Settings />, { participant: withBoard, storage });
    await waitFor(() => expect(screen.getByTestId('board-ivory')).toBeTruthy());
    // Still the device's, not the account's.
    expect(readBoardPreference(storage).surface).toBe('ivory');
    expect(readBoardPreference(storage).ink).toBe('blue');
  });
});
