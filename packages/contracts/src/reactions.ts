import { z } from 'zod';

/**
 * Reactions: how somebody says something without taking the floor.
 *
 * A room can hold twelve people and one expert who is mid-sentence. Speaking
 * costs the whole room its place — the conductor cancels playback the moment a
 * voice is confirmed — so agreeing, laughing, or admitting you are lost has to
 * cost nothing. A reaction is a broadcast and nothing else: it never reaches
 * the lesson, the plan, the expert, the board or the audio path, and it is
 * never an interrupt.
 *
 * Eight, fixed, rendered as text by the platform's own emoji font: no image
 * assets, no picker library, no per-locale skin-tone state to carry. The last
 * one is deliberate — a learner who is lost can say so without speaking. It is
 * expression only and is wired to nothing.
 */
export const REACTIONS = ['👍', '👏', '❤️', '🔥', '😂', '🤯', '🎉', '😕'] as const;

export const Reaction = z.enum(REACTIONS);
export type Reaction = z.infer<typeof Reaction>;

/**
 * What a screen reader says instead of the glyph. Emoji names vary by platform
 * and by assistive technology, and "grinning squinting face" is not what the
 * sender meant; these are the meanings this product attaches to them.
 */
export const REACTION_LABEL: Record<Reaction, string> = {
  '👍': 'agrees',
  '👏': 'applauds',
  '❤️': 'loves this',
  '🔥': 'says this is great',
  '😂': 'is laughing',
  '🤯': 'is amazed',
  '🎉': 'is celebrating',
  '😕': 'is lost',
};

/**
 * One reaction per participant per this many milliseconds. Anything faster is
 * dropped in silence: a held-down key is not an error, and a room full of
 * people should never see a rate-limit notice for tapping an emoji.
 */
export const REACTION_MIN_INTERVAL_MS = 600;

/** How long a reaction stays on screen before it fades. */
export const REACTION_TTL_MS = 4_000;

/** At most this many are drawn at once; the oldest goes when a newer one arrives. */
export const REACTION_MAX_VISIBLE = 5;
