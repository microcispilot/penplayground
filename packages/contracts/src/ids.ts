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
