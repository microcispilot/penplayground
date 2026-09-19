import { timingSafeEqual } from 'node:crypto';

/**
 * Who may read the owner's numbers.
 *
 * The statistics carry every learner's spend, plan, country and device, which
 * makes them the most sensitive thing this API serves. They are guarded by
 * the same allow-list the operations console uses (ADR-0026): a Google
 * address in `PEN_ADMIN_EMAILS`, checked against the participant's own row,
 * and unset means nobody — in development as well as in production. One set
 * of people who may see `/api/admin/*`, not two.
 *
 * This file adds the one thing a report needs that a console does not: a way
 * in for a machine. `PEN_ADMIN_TOKEN` in `Authorization: Bearer` or
 * `X-Admin-Token` lets a scheduled export or a probe read a report without a
 * Google account. It is compared in constant time and refused outright below
 * 32 characters, so a short secret cannot be configured by accident.
 */

/** The shortest secret this will accept. Anything shorter is treated as unset. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

/** The configured machine token, or null when there is none worth having. */
export function adminToken(cfg: { PEN_ADMIN_TOKEN?: string | undefined }): string | null {
  const token = cfg.PEN_ADMIN_TOKEN;
  return token && token.length >= MIN_ADMIN_TOKEN_LENGTH ? token : null;
}

/** Constant-time, and never true for an absent, empty or differently sized candidate. */
export function secretMatches(expected: string | null, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AdminHeaders {
  /** `Authorization`, whatever it carries: a learner's bearer, or the machine token. */
  authorization: string | undefined;
  /** `X-Admin-Token`, for a caller that also needs the bearer for something else. */
  adminToken: string | undefined;
}

/** True when these headers carry the configured machine token. */
export function machineIsAdmin(token: string | null, headers: AdminHeaders): boolean {
  const bearer = headers.authorization?.startsWith('Bearer ')
    ? headers.authorization.slice(7).trim()
    : undefined;
  return secretMatches(token, headers.adminToken) || secretMatches(token, bearer);
}
