import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing. Argon2id, with the parameters written down.
 *
 * Simurgh calls `PasswordHash.recommended()` and takes whatever the library
 * thinks is right that month. That is fine until the library changes its mind
 * in a patch release and a deploy silently starts writing weaker hashes — or
 * stronger ones that blow the request budget. The port's own notes flagged it,
 * so the numbers are pinned here and are the same numbers Simurgh's embedded
 * dummy hash documents: 64 MiB, three passes, four lanes.
 *
 * They are a cost, and the cost is the point. 64 MiB per verification is what
 * makes a stolen table expensive to attack; it is also why these calls are
 * awaited and never made in a loop. Measured on this hardware: 15-17 ms per
 * verification, whether it succeeds or fails.
 */
const PARAMS = {
  /** Argon2id: memory-hard like 2d, side-channel resistant like 2i. */
  algorithm: 2 as const,
  version: 1 as const,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} satisfies Parameters<typeof hash>[1];

/**
 * A real hash of a password nobody knows, verified against when there is no
 * account or no password.
 *
 * This is not decoration. Without it, "no such address" returns in a
 * microsecond and "wrong password" returns in ~100 ms, and that difference is
 * a free account-enumeration oracle — anyone can learn which addresses are
 * registered by timing the refusals. Every failing path verifies against this
 * instead, so they all cost the same.
 *
 * It is a *real* hash, produced by the code above and checked — the first
 * draft of this file carried a hand-written one that looked plausible and
 * parsed as nothing, which would have thrown inside `verify`, been swallowed
 * by the catch below, and returned false in a microsecond. The timing defence
 * would have been gone and every test would still have passed.
 * `test/auth-passwords.test.ts` verifies against it so that cannot recur.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$/pxIfk4kKxywMmv1oFE14A$eq346g0eD7/Hqz9sT9x7kbypbmKxrcnivscr79CtgTQ';

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

/**
 * True when the password matches.
 *
 * `stored` may be null — an anonymous account, or one that only ever signed in
 * with Google. That case still does the full verification against the dummy,
 * so it takes as long as a real failure. Returning early here would undo the
 * whole point of the dummy hash.
 *
 * Any error is a false, never a throw: a malformed hash in the table is a
 * refusal to sign in, not a 500 that tells the caller the row is interesting.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  try {
    return await verify(stored ?? DUMMY_HASH, password, PARAMS);
  } catch {
    return false;
  }
}
