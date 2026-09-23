import {
  type BoardPreference,
  type BoardSurface,
  type InkId,
  resolveInkId,
  resolveSurface,
} from '@pen/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import {
  applyBoardAttributes,
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
  const { platform, participant } = useApp();
  const [theme] = useTheme();
  const preference = useSyncExternalStore(
    subscribeToBoardPreference,
    () => boardPreference(platform.storage),
    () => boardPreference(platform.storage),
  );

  const plan = participant?.plan ?? 'free';
  const surface = resolveSurface(plan, preference.surface, isDarkTheme(theme) ? 'dark' : 'light');
  // `surface.kind` is only null for `auto`, and `resolveSurface` never returns
  // `auto` — it resolves it. The fallback is for the type, not for a real case.
  const ink = resolveInkId(plan, preference, surface.kind ?? 'marker');

  // Stamped in an effect rather than during render: writing to `document`
  // while rendering is a side effect React is allowed to run twice.
  useEffect(() => {
    applyBoardAttributes(surface.id, ink);
  }, [surface.id, ink]);

  return {
    preference,
    surface,
    ink,
    choose: (next) => setBoardPreference(platform.storage, next),
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
