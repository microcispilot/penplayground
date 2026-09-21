import { z } from 'zod';

/** Model-minted ids are short and sequential so a cheap model never gets them wrong. */
/**
 * `s7` from the model; `s7a`, `s7b` when the gateway splits an over-long
 * sentence; `L2.s7` / `t3.s7` once the room qualifies it with its thread so
 * ids are unique across the whole session (audio frames reference them).
 */
export const ID_PREFIX = /^(?:[A-Za-z][A-Za-z0-9]{0,7}\.)?/;
export const SayId = z.string().regex(/^(?:[A-Za-z][A-Za-z0-9]{0,7}\.)?s\d{1,4}[a-z]?$/);
export const BoardId = z.string().regex(/^(?:[A-Za-z][A-Za-z0-9]{0,7}\.)?b\d{1,4}$/);
export const CheckId = z.string().regex(/^(?:[A-Za-z][A-Za-z0-9]{0,7}\.)?c\d{1,4}$/);

/** Server-minted ids. */
export const SessionId = z.string().min(8).max(64);
export const ParticipantId = z.string().min(8).max(64);
export const ExpertId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(3)
  .max(64);

export type SayId = z.infer<typeof SayId>;
export type BoardId = z.infer<typeof BoardId>;
export type CheckId = z.infer<typeof CheckId>;
export type SessionId = z.infer<typeof SessionId>;
export type ParticipantId = z.infer<typeof ParticipantId>;
export type ExpertId = z.infer<typeof ExpertId>;

/**
 * The colour of a person, as a hue.
 *
 * One hash, in one place, because an avatar's colour is an *identity*: the
 * header chip and the tile in the room are the two places somebody sees
 * their own avatar at the same moment, and they were computed by two
 * functions that looked identical and were not. The client's took the
 * modulus on every step; the room's coerced to uint32 and took it once. For
 * most ids those disagree, so the same person was two colours.
 *
 * It lives in contracts rather than in either of them for exactly that
 * reason — the server picks it, the client draws it, and neither owns it.
 */
export function avatarHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
