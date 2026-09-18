import { z } from 'zod';
import { SessionId } from './ids.js';

/**
 * A participant's lists (ADR-0015). "Saved" is the sidebar's *Learn later*,
 * "liked" is *Liked*; history is every session they sat in. Lists hang off the
 * participant id, so an anonymous participant's lists live on this device
 * until a Google sign-in adopts them onto the account.
 */
export const ListKind = z.enum(['saved', 'liked']);
export type ListKind = z.infer<typeof ListKind>;

/** The role a participant had in a session they visited. */
export const VisitRole = z.enum(['host', 'guest']);
export type VisitRole = z.infer<typeof VisitRole>;

/** How a session sits in the caller's history. */
export const Visit = z.object({
  role: VisitRole,
  /** Last time they took a seat, ms epoch. */
  at: z.number().int().nonnegative(),
});
export type Visit = z.infer<typeof Visit>;

/** One read for the sidebar and every card: membership ids and the counts next to each row. */
export const ListSummary = z.object({
  savedIds: z.array(SessionId),
  likedIds: z.array(SessionId),
  counts: z.object({
    hosted: z.number().int().nonnegative(),
    history: z.number().int().nonnegative(),
    saved: z.number().int().nonnegative(),
    liked: z.number().int().nonnegative(),
  }),
});
export type ListSummary = z.infer<typeof ListSummary>;

export const EMPTY_LIST_SUMMARY: ListSummary = {
  savedIds: [],
  likedIds: [],
  counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
};

/** `PUT`/`DELETE /api/sessions/:id/save`. */
export const SaveResult = z.object({ saved: z.boolean() });
export type SaveResult = z.infer<typeof SaveResult>;

/** `PUT`/`DELETE /api/sessions/:id/like`: the caller's state and the public count afterwards. */
export const LikeResult = z.object({ liked: z.boolean(), likes: z.number().int().nonnegative() });
export type LikeResult = z.infer<typeof LikeResult>;
