import { REACTION_MAX_VISIBLE, REACTION_TTL_MS, type Reaction } from '@pen/contracts';

/**
 * A reaction on its way across the panel: who sent it, what they sent, and
 * when the room stamped it. The list is short and self-pruning — the panel
 * draws a handful of pills, not a feed.
 */
export interface LiveReaction {
  /** Unique per arrival, so two identical reactions are two pills. */
  id: string;
  participantId: string;
  /** The sender's name at the moment they reacted (they may leave before it fades). */
  name: string;
  hue: number;
  emoji: Reaction;
  /** Server wall clock, ms since epoch. */
  at: number;
}

/**
 * Add one, drop what has faded, and keep the newest few. Bounded here rather
 * than by a timer per pill: a room of twelve tapping at once must not be able
 * to pile a hundred nodes over the participants.
 */
export function pushReaction(
  list: readonly LiveReaction[],
  reaction: LiveReaction,
  now = Date.now(),
): LiveReaction[] {
  return [...list, reaction]
    .filter((r) => now - r.at < REACTION_TTL_MS)
    .slice(-REACTION_MAX_VISIBLE);
}

/** What is still on screen at `now`. */
export function visibleReactions(list: readonly LiveReaction[], now = Date.now()): LiveReaction[] {
  return list.filter((r) => now - r.at < REACTION_TTL_MS);
}
