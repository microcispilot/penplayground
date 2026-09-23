import { randomBytes } from 'node:crypto';
import {
  CHALLENGE_RESEND_COOLDOWN_SECONDS,
  CHALLENGE_TTL_SECONDS,
  CompleteRegistrationRequest,
  LoginRequest,
  ResetPasswordRequest,
  StartChallengeRequest,
} from '@pen/contracts';
import type { Context, Hono } from 'hono';
import { logger } from '../logger.js';
import type { ChallengeStore } from './challenges.js';
import { existingAccountEmail, type Mailer, resetEmail, verificationEmail } from './mailer.js';
import { hashPassword, verifyPassword } from './passwords.js';
import type { AuthAction, AuthRateLimiter } from './rate-limit.js';

/**
 * Email and password sign-in.
 *
 * The flow is Simurgh's, re-implemented rather than copied (that one is
 * FastAPI). Registration is two steps with a code in between; the account
 * exists only once a code sent to the address comes back, which is what makes
 * every password account's address verified at the moment it is created.
 *
 * ── the rule every response here obeys ─────────────────────────────────────
 *
 * **Nothing tells an unauthenticated caller whether an address has an
 * account.** Not the status, not the body, not the timing. Asking for a
 * challenge on a registered address returns the same 202 with a real-looking
 * id as one that is not; the difference goes to the mailbox. A wrong password
 * and an unknown address return the same 401 after the same Argon2 work.
 *
 * It is worth being blunt about why, because it costs real clarity in the UI:
 * an address list is the raw material for credential stuffing and for
 * "somebody you know uses this app" phishing, and it is the one thing an
 * anonymous caller can otherwise harvest at leisure.
 */

export interface AuthDeps {
  challenges: ChallengeStore;
  mailer: Mailer;
  limiter: AuthRateLimiter;
  /** Where "sign in instead" points in the already-registered email. */
  signInUrl: string;
  clientIp: (c: Context) => string;
  /** Whether email sign-in is on for this caller and platform; absent means always. */
  enabled?: (c: Context) => Promise<boolean> | boolean;
  /** Find an account by address. A list, because an address is not a key. */
  findByEmail: (email: string) => Promise<
    Array<{
      id: string;
      name: string;
      plan: 'free' | 'standard' | 'professional';
      passwordHash: string | null;
    }>
  >;
  /** The caller's own row, from their bearer, when they have one. */
  callerId: (authorization: string | undefined) => Promise<string | null>;
  /** Turn a row into a password account, keeping its id and its sessions. */
  attachPassword: (
    id: string,
    account: { email: string; name: string; passwordHash: string; verifiedAt: Date },
  ) => Promise<{ id: string; name: string; plan: 'free' | 'standard' | 'professional' } | null>;
  /** A brand-new anonymous row to attach an account to. */
  createBlank: (name: string) => Promise<{ id: string }>;
  setPassword: (id: string, hash: string, at: Date) => Promise<boolean>;
  /** Mint a bearer for an account, exactly as Google sign-in does. */
  issue: (account: {
    id: string;
    name: string;
    plan: 'free' | 'standard' | 'professional';
  }) => Promise<{ token: string; participant: unknown }>;
}

const MINUTES = Math.round(CHALLENGE_TTL_SECONDS / 60);

/** The identical answer a challenge request gives, whatever the truth is. */
function accepted(challengeId: string) {
  return {
    challengeId,
    expiresInSeconds: CHALLENGE_TTL_SECONDS,
    resendAvailableInSeconds: CHALLENGE_RESEND_COOLDOWN_SECONDS,
  };
}

/**
 * An id that looks exactly like a real one but names nothing.
 *
 * Returned when we are not going to send a code — an address that already has
 * an account, or one that has none during a reset. Without it the response
 * shape itself would leak: a real id means "new address", an error means
 * "taken", and the enumeration we just spent all this care preventing is back.
 *
 * "Exactly" is doing real work in that first sentence. The first version of
 * this built the id out of `Math.random().toString(36)` and a timestamp, which
 * produced a *different alphabet and a different length* from the real ones —
 * so a decoy was identifiable on sight, and the whole defence was decoration.
 * It is minted the same way a real id is, and `auth-password.test.ts` compares
 * their shapes so it cannot drift apart again.
 */
function decoyId(): string {
  return `ch_${randomBytes(12).toString('base64url')}`;
}

export function registerAuthRoutes(app: Hono, deps: AuthDeps): void {
  const guard = (action: AuthAction, ip: string, email: string | null) =>
    deps.limiter.check(action, ip, email);

  /**
   * Every route here is behind one flag (`email_sign_in`, ADR-0036), decided
   * by the caller's platform: a client that hides the form still cannot use
   * it. 503 with the same body the Google route gives when it is off, so a
   * client has one thing to say.
   */
  app.use('/api/auth/*', async (c, next) => {
    if (c.req.path === '/api/auth/anonymous' || (await (deps.enabled?.(c) ?? true))) return next();
    return c.json(
      { error: 'EMAIL_SIGN_IN_DISABLED', message: 'Email sign-in is not available here.' },
      503,
    );
  });

  /**
   * Step one of signing up: name an address, get a code.
   *
   * Always 202, always the same body. When the address already has an account
   * we send *that* person a note saying so — which is useful to them and
   * useless to a stranger — and return a decoy id, so the two cases are
   * indistinguishable from outside.
   */
  app.post('/api/auth/register/start', async (c) => {
    const ip = deps.clientIp(c);
    const body = StartChallengeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const { email } = body.data;

    const verdict = guard('challenge.register', ip, email);
    if (!verdict.ok) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: 'RATE_LIMITED', retryAfter: verdict.retryAfter }, 429);
    }

    const existing = await deps.findByEmail(email);
    if (existing.length > 0) {
      const mail = existingAccountEmail(deps.signInUrl);
      await deps.mailer
        .send({ to: email, ...mail })
        .catch((err: unknown) => logger.warn({ evt: 'auth.mail_failed', err }, 'notice not sent'));
      return c.json(accepted(decoyId()), 202);
    }

    const challenge = await deps.challenges.issue('register', email);
    const mail = verificationEmail(challenge.code, MINUTES);
    try {
      await deps.mailer.send({ to: email, ...mail });
    } catch (err) {
      // A relay that is down is our problem, not the caller's fault, and it is
      // the one case where the honest answer is an error: pretending to have
      // sent a code leaves them waiting for mail that will never come.
      logger.error({ evt: 'auth.mail_failed', err }, 'verification code could not be sent');
      c.header('Retry-After', '60');
      return c.json({ error: 'MAIL_UNAVAILABLE' }, 503);
    }
    return c.json(accepted(challenge.id), 202);
  });

  /** Another code for the same address. A new row; the old one is dead. */
  app.post('/api/auth/register/resend/:id', async (c) => {
    const ip = deps.clientIp(c);
    const verdict = guard('challenge.resend', ip, null);
    if (!verdict.ok) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: 'RATE_LIMITED', retryAfter: verdict.retryAfter }, 429);
    }
    const next = await deps.challenges.resend('register', c.req.param('id'));
    // Refused for any reason — cooldown, cap, consumed, unknown id — answers
    // the same way: a caller must not learn which of those it was.
    if (!next) return c.json(accepted(decoyId()), 202);
    const mail = verificationEmail(next.code, MINUTES);
    await deps.mailer
      .send({ to: next.email, ...mail })
      .catch((err: unknown) => logger.warn({ evt: 'auth.mail_failed', err }, 'resend not sent'));
    return c.json(accepted(next.id), 202);
  });

  /**
   * Step two: the code, a name and a password become an account.
   *
   * If the caller has an anonymous bearer, that row *becomes* the account —
   * same id, so every session they already started stays theirs. That is the
   * same in-place upgrade Google sign-in does, and it is the reason someone
   * can learn something first and sign up afterwards without losing it.
   */
  app.post('/api/auth/register/complete', async (c) => {
    const ip = deps.clientIp(c);
    const verdict = guard('complete', ip, null);
    if (!verdict.ok) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: 'RATE_LIMITED', retryAfter: verdict.retryAfter }, 429);
    }
    const body = CompleteRegistrationRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);

    const email = await deps.challenges.claim('register', body.data.challengeId, body.data.code);
    if (!email) return c.json({ error: 'BAD_CODE', message: 'That code is not valid.' }, 400);

    // Claimed the code, then found the address taken: a race with another
    // sign-up, or a decoy id that happened to be guessed. The code is spent
    // either way, which is the point of consuming before this check.
    const existing = await deps.findByEmail(email);
    if (existing.length > 0) {
      return c.json({ error: 'BAD_CODE', message: 'That code is not valid.' }, 400);
    }

    const passwordHash = await hashPassword(body.data.password);
    const callerId = await deps.callerId(c.req.header('authorization'));
    const id = callerId ?? (await deps.createBlank(body.data.name)).id;
    const account = await deps.attachPassword(id, {
      email,
      name: body.data.name,
      passwordHash,
      verifiedAt: new Date(),
    });
    if (!account) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json(await deps.issue(account), 201);
  });

  /** Sign in. One refusal, whatever went wrong. */
  app.post('/api/auth/login', async (c) => {
    const ip = deps.clientIp(c);
    const body = LoginRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const { email, password } = body.data;

    const verdict = guard('login', ip, email);
    if (!verdict.ok) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: 'RATE_LIMITED', retryAfter: verdict.retryAfter }, 429);
    }

    const rows = await deps.findByEmail(email);
    const account = rows[0] ?? null;
    // Always verified, even with no account and even when the account has no
    // password: `verifyPassword` falls back to a dummy hash so all three
    // failures cost the same time. Returning early here would rebuild the
    // timing oracle the dummy exists to close.
    const ok = await verifyPassword(password, account?.passwordHash ?? null);
    if (!ok || !account) {
      return c.json(
        { error: 'BAD_CREDENTIALS', message: 'That email and password do not match.' },
        401,
      );
    }
    return c.json(await deps.issue(account));
  });

  /** Ask for a reset code. Always 202, account or not. */
  app.post('/api/auth/password/forgot', async (c) => {
    const ip = deps.clientIp(c);
    const body = StartChallengeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const { email } = body.data;

    const verdict = guard('challenge.reset', ip, email);
    if (!verdict.ok) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: 'RATE_LIMITED', retryAfter: verdict.retryAfter }, 429);
    }

    const rows = await deps.findByEmail(email);
    if (rows.length === 0) return c.json(accepted(decoyId()), 202);

    const challenge = await deps.challenges.issue('reset', email);
    const mail = resetEmail(challenge.code, MINUTES);
    await deps.mailer
      .send({ to: email, ...mail })
      .catch((err: unknown) => logger.warn({ evt: 'auth.mail_failed', err }, 'reset not sent'));
    return c.json(accepted(challenge.id), 202);
  });

  /**
   * Set a new password with a reset code.
   *
   * This also signs them in, because the alternative is asking somebody who
   * has just proved they hold the mailbox *and* chosen a new password to type
   * it again on the next screen.
   */
  app.post('/api/auth/password/reset', async (c) => {
    const ip = deps.clientIp(c);
    const verdict = guard('complete', ip, null);
    if (!verdict.ok) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: 'RATE_LIMITED', retryAfter: verdict.retryAfter }, 429);
    }
    const body = ResetPasswordRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);

    const email = await deps.challenges.claim('reset', body.data.challengeId, body.data.code);
    if (!email) return c.json({ error: 'BAD_CODE', message: 'That code is not valid.' }, 400);

    const rows = await deps.findByEmail(email);
    const account = rows[0];
    if (!account) return c.json({ error: 'BAD_CODE', message: 'That code is not valid.' }, 400);

    const hash = await hashPassword(body.data.password);
    const written = await deps.setPassword(account.id, hash, new Date());
    if (!written) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json(await deps.issue(account));
  });
}
