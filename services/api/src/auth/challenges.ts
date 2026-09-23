import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_MAX_SENDS,
  CHALLENGE_RESEND_COOLDOWN_SECONDS,
  CHALLENGE_TTL_SECONDS,
  type ChallengePurpose,
} from '@pen/contracts';
import type { AuthChallengeRepository } from '@pen/db';

/**
 * The one-time code that stands between a stranger and an account.
 *
 * Ported from Simurgh's registration challenge, including the part that
 * matters most and is easiest to get wrong: **the code is claimed in a single
 * conditional UPDATE**, never read-then-written. Checking a row and then
 * marking it used in two statements leaves a window where two requests both
 * see an unconsumed row, and eight digits are cheap enough to guess in
 * parallel that the window is not theoretical.
 */

/** Eight digits, ~26.6 bits, from the CSPRNG. `randomInt` is uniform; `% 1e8` is not. */
export function generateCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

/**
 * The stored form of a code.
 *
 * HMAC, not a bare hash, and bound to the challenge id *and* the address. The
 * binding is what stops a digest lifted from one row being replayed into
 * another: the same eight digits produce a different digest for a different
 * challenge, so a table full of digests is not a table full of codes.
 *
 * The secret is separate from the JWT secret where one is configured, so
 * compromising one does not hand over the other.
 */
export function codeDigest(secret: string, id: string, email: string, code: string): string {
  return createHmac('sha256', secret)
    .update(`pen:auth:v1:code\0${id}:${email}:${code}`)
    .digest('hex');
}

/** Constant-time compare, so a digest cannot be recovered a byte at a time. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface IssuedChallenge {
  id: string;
  /** The address the code went to. A resend needs it and only the row has it. */
  email: string;
  code: string;
  expiresAt: Date;
  resendAvailableInSeconds: number;
}

export interface ChallengeStore {
  issue(purpose: ChallengePurpose, email: string): Promise<IssuedChallenge>;
  /** Claim a code. Returns the address it was issued to, or null. Single use. */
  claim(purpose: ChallengePurpose, id: string, code: string): Promise<string | null>;
  /** Replace a live challenge with a fresh one. Null when the cooldown or cap says no. */
  resend(purpose: ChallengePurpose, id: string): Promise<IssuedChallenge | null>;
  /** Delete challenges that expired long enough ago to be uninteresting. */
  sweep(): Promise<number>;
}

const RETENTION_MS = 24 * 60 * 60 * 1000;

export function createChallengeStore(
  rows: AuthChallengeRepository,
  secret: string,
  now: () => Date = () => new Date(),
): ChallengeStore {
  /*
   * An opaque id. Not a secret — the code is the secret — but it must be
   * unguessable enough that nobody can enumerate live challenges, so it is
   * twelve random bytes rather than a counter.
   *
   * `randomInt(0, 2 ** 48)` was the first attempt and it throws: Node's
   * exclusive max is 2**48 - 1, so the range was over by exactly one and every
   * call failed. Caught by the tests rather than in production, which is the
   * whole argument for having written them first.
   */
  const newId = () => `ch_${randomBytes(12).toString('base64url')}`;

  async function insert(
    purpose: ChallengePurpose,
    email: string,
    sendCount = 1,
  ): Promise<IssuedChallenge> {
    const id = newId();
    const code = generateCode();
    const at = now();
    const expiresAt = new Date(at.getTime() + CHALLENGE_TTL_SECONDS * 1000);
    await rows.insert({
      id,
      purpose,
      email,
      codeDigest: codeDigest(secret, id, email, code),
      expiresAt,
      resendNotBefore: new Date(at.getTime() + CHALLENGE_RESEND_COOLDOWN_SECONDS * 1000),
      sendCount,
    });
    return {
      id,
      email,
      code,
      expiresAt,
      resendAvailableInSeconds: CHALLENGE_RESEND_COOLDOWN_SECONDS,
    };
  }

  const store: ChallengeStore = {
    async issue(purpose, email) {
      // Housekeeping rides along with the request that creates work, the way
      // Simurgh does it: no scheduler to forget to run, and the cost lands on
      // the path that is already writing.
      void store.sweep().catch(() => undefined);
      return insert(purpose, email);
    },

    /**
     * The digest is compared here, not in SQL, because a SQL `=` on a digest is
     * not constant time. The row is fetched by id — which is not a secret — and
     * the secret comparison happens in `sameDigest`.
     *
     * A correct code then goes through `claim`, where every remaining condition
     * lives inside one conditional UPDATE, so the code is single-use even
     * against two simultaneous requests.
     */
    async claim(purpose, id, code) {
      const at = now();
      const row = await rows.get(purpose, id);
      if (!row) return null;

      const expected = codeDigest(secret, row.id, row.email, code);
      if (!sameDigest(expected, row.codeDigest)) {
        await rows.countFailure(id, at, CHALLENGE_MAX_ATTEMPTS);
        return null;
      }
      const email = await rows.claim(id, at, CHALLENGE_MAX_ATTEMPTS);
      // Right code, unusable row: expired, locked, already spent. Counted, so
      // that replaying a consumed code is not a free probe.
      if (!email) await rows.countFailure(id, at, CHALLENGE_MAX_ATTEMPTS);
      return email;
    },

    /**
     * A resend is a *new row*, not an update.
     *
     * Updating the code in place would leave the old one valid until the write
     * landed, and would let a single challenge id mint codes forever. Locking
     * the old row and inserting a new one means every code belongs to exactly
     * one row, and the old code is dead the moment a new one exists. The send
     * count travels across, or the cap would reset itself every time.
     */
    async resend(purpose, id) {
      const at = now();
      const row = await rows.get(purpose, id);
      if (!row) return null;
      if (
        row.consumedAt !== null ||
        row.lockedAt !== null ||
        row.expiresAt.getTime() <= at.getTime() ||
        row.resendNotBefore.getTime() > at.getTime() ||
        row.sendCount >= CHALLENGE_MAX_SENDS
      ) {
        return null;
      }
      await rows.lock(id, at);
      return insert(purpose, row.email, row.sendCount + 1);
    },

    async sweep() {
      return rows.sweep(new Date(now().getTime() - RETENTION_MS));
    },
  };
  return store;
}

/** Live challenges for an address since a moment — the per-mailbox cap. */
export function recentChallengeCount(
  rows: AuthChallengeRepository,
  purpose: ChallengePurpose,
  email: string,
  since: Date,
): Promise<number> {
  return rows.countSince(purpose, email, since);
}
