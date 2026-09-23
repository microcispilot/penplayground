import { z } from 'zod';

/**
 * Email and password sign-in, ported from Simurgh's flow.
 *
 * The *process* is Simurgh's and deliberately so — the owner asked to reuse it
 * rather than invent one. The code is not: Simurgh is FastAPI with
 * `pwdlib[argon2]` and `smtplib`, and none of that crosses to Node. What
 * crosses is the shape of the thing:
 *
 *   · Registration is **two steps with a code in between**, never a single
 *     form. You ask for a challenge with an address, an eight-digit code goes
 *     to that mailbox, and the account is created only when the code comes
 *     back. That is what makes an address verified at the moment of creation
 *     rather than "verified later, maybe".
 *   · The code is **never stored**. Only an HMAC of it, bound to the challenge
 *     and the address, so a leaked table row is not a set of usable codes.
 *   · Every answer is **enumeration-proof**. Asking for a challenge on an
 *     address that already has an account returns the same 202 with a decoy id
 *     as one that does not; the difference goes to the mailbox, where only its
 *     owner can read it.
 *
 * ── where Pen departs, and why ─────────────────────────────────────────────
 *
 * **Password reset exists here and does not exist in Simurgh.** A repo-wide
 * search there for reset/forgot returns nothing. A sign-in form without
 * "Forgot password?" is a form that loses accounts, so it is built here on the
 * same challenge machinery, separated by `purpose`.
 *
 * **No Turnstile.** Simurgh gates the challenge endpoint with a CAPTCHA; Pen
 * has none, so the rate limiter is the whole defence and it is tighter here
 * per address. Worth revisiting if the endpoint is ever abused.
 *
 * **The session stays Pen's.** Simurgh issues a cookie and revokes through
 * Redis; Pen has issued a bearer token since the first anonymous learner and
 * has no Redis. Sign-in returns a token exactly as Google sign-in already
 * does, so nothing downstream of identity changes.
 */

/** An address, normalised the one way the whole system agrees on. */
export const Email = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .transform((v) => v.toLowerCase())
  .refine((v) => /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(v), 'that does not look like an email');

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/**
 * The classes a password must draw from. Simurgh's rule, kept: **at least
 * three of four**, rather than "one of each".
 *
 * Requiring all four is where password rules start producing `Password1!` —
 * everybody satisfies the checklist the same lazy way. Three of four leaves
 * room for a long passphrase with no symbol in it, which is the stronger
 * password and the one a person will actually remember.
 */
const CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

export function passwordClassCount(password: string): number {
  return CLASSES.filter((re) => re.test(password)).length;
}

/**
 * The rule, in one place, so the form and the server cannot disagree about
 * what is acceptable — a client that accepts what the server refuses is a
 * dead end the person cannot get out of.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (passwordClassCount(password) < 3) {
    return 'Mix at least three of: lowercase, uppercase, numbers, symbols.';
  }
  return null;
}

export const Password = z
  .string()
  .min(PASSWORD_MIN)
  .max(PASSWORD_MAX)
  .refine((v) => passwordProblem(v) === null, {
    message: `Use ${PASSWORD_MIN}+ characters, mixing at least three of lowercase, uppercase, numbers and symbols.`,
  });

/** Exactly eight digits. Typed back from an email, so nothing else is accepted. */
export const VerificationCode = z.string().regex(/^[0-9]{8}$/, 'The code is eight digits.');

export const DisplayName = z.string().trim().min(2).max(60);

/** What a challenge is for. One table, two lives; see the header. */
export const ChallengePurpose = z.enum(['register', 'reset']);
export type ChallengePurpose = z.infer<typeof ChallengePurpose>;

// ── requests ────────────────────────────────────────────────────────────────

export const StartChallengeRequest = z.object({ email: Email });
export type StartChallengeRequest = z.infer<typeof StartChallengeRequest>;

export const CompleteRegistrationRequest = z.object({
  challengeId: z.string().min(1).max(64),
  code: VerificationCode,
  name: DisplayName,
  password: Password,
});
export type CompleteRegistrationRequest = z.infer<typeof CompleteRegistrationRequest>;

export const LoginRequest = z.object({
  email: Email,
  // Deliberately NOT `Password`: an old password that no longer satisfies
  // today's rule must still sign in. Strength is a rule about choosing one.
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ResetPasswordRequest = z.object({
  challengeId: z.string().min(1).max(64),
  code: VerificationCode,
  password: Password,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

// ── responses ───────────────────────────────────────────────────────────────

/**
 * What a challenge request answers with — identically whether or not the
 * address has an account, and whether or not a mail was actually sent. The
 * `challengeId` may be a decoy.
 */
export const ChallengeAccepted = z.object({
  challengeId: z.string(),
  expiresInSeconds: z.number().int().positive(),
  resendAvailableInSeconds: z.number().int().nonnegative(),
});
export type ChallengeAccepted = z.infer<typeof ChallengeAccepted>;

/** How long a code lives, and how long before another may be sent. */
export const CHALLENGE_TTL_SECONDS = 600;
export const CHALLENGE_RESEND_COOLDOWN_SECONDS = 60;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const CHALLENGE_MAX_SENDS = 3;
