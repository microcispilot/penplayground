import {
  type BoardPreference,
  type BoardSurface,
  type BoardTool,
  type InkId,
  resolveInk,
  resolveSurface,
  resolveTool,
} from '@pen/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import {
  applyBoardAttributes,
  BOARD_PREFERENCE_KEY,
  boardPreference,
  setBoardPreference,
  subscribeToBoardPreference,
} from './board-preference.js';
import { useApp } from './context.js';
import { isDarkTheme, useTheme } from './theme.js';

export interface ResolvedBoard {
  /** What the learner picked, unresolved — this is what Settings shows as chosen. */
  preference: BoardPreference;
  /** What is actually painted, after the theme and the plan have had their say. */
  surface: BoardSurface;
  ink: InkId;
  tool: BoardTool;
  /** Replace the whole preference. Persists to the device and tells every reader. */
  choose: (next: BoardPreference) => void;
}

/**
 * The board, resolved.
 *
 * Three inputs decide what is painted and all three move independently, which
 * is why this is a hook rather than a value computed once at boot:
 *
 *   · **the preference**, which changes in Settings;
 *   · **the theme**, because `auto` is a whiteboard by day and a blackboard at
 *     night — so toggling dark mode repaints the board with no board change;
 *   · **the plan**, which arrives *after* first paint. `participant` is null
 *     until identity comes back, so a subscriber's own board would flash the
 *     free default for a beat if this were read once.
 *
 * The plan is read as `free` while identity is in flight, on purpose. Showing
 * the default briefly and then upgrading to the chosen board is the honest
 * direction to fail; the other way round — painting a paid board and snatching
 * it back — looks like a bug and, on a shared machine, leaks what somebody
 * else pays for.
 */
export function useBoard(): ResolvedBoard {
  const { platform, participant, api } = useApp();
  const [theme] = useTheme();
  const preference = useSyncExternalStore(
    subscribeToBoardPreference,
    () => boardPreference(platform.storage),
    () => boardPreference(platform.storage),
  );

  const plan = participant?.plan ?? 'free';
  const surface = resolveSurface(plan, preference.surface, isDarkTheme(theme) ? 'dark' : 'light');
  const ink = resolveInk(plan, preference.ink, surface);
  const tool = resolveTool(plan, preference.tool, surface);

  // Stamped in an effect rather than during render: writing to `document`
  // while rendering is a side effect React is allowed to run twice.
  useEffect(() => {
    applyBoardAttributes(surface.id, ink, tool);
  }, [surface.id, ink, tool]);

  /*
   * A machine that has never chosen adopts the account's board, once.
   *
   * Device-first does not mean device-only: a learner who set a green board on
   * their laptop should find it on their phone. The guard is that this only
   * fires when the device holds *nothing* — `readBoardPreference` returning
   * the default is not the same as the learner having chosen the default, so
   * the raw key is checked instead. Without that, signing in would overwrite a
   * choice made on this machine five seconds earlier.
   */
  useEffect(() => {
    const fromAccount = participant?.board;
    if (!fromAccount) return;
    if (platform.storage.get(BOARD_PREFERENCE_KEY) !== null) return;
    setBoardPreference(platform.storage, fromAccount);
  }, [participant, platform.storage]);

  return {
    preference,
    surface,
    ink,
    tool,
    choose: (next) => {
      // The device write is the one that counts and cannot fail; the account
      // write is a courtesy that never blocks and never reports (see
      // `ApiClient.rememberBoard`, and `RoomSession.keepPace` before it).
      setBoardPreference(platform.storage, next);
      api.rememberBoard(next);
    },
  };
}

/**
 * Mounted once at the router root so every route — the shell, the room and the
 * replay alike — has the board stamped on `<html>`. The room and the replay
 * are outside the shell, so a component inside `AppShell` would leave the two
 * screens that are *entirely board* without one.
 */
export function BoardAttributes() {
  useBoard();
  return null;
}
