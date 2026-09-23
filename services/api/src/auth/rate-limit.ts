import { createHmac } from 'node:crypto';

/**
 * Rate limiting for the auth endpoints.
 *
 * Simurgh does this three-dimensionally — network prefix, address, and a
 * global ceiling — through a Redis Lua script. Pen has no Redis and one API
 * container, so the same three dimensions live in memory here. That is a real
 * difference and worth naming: **this does not survive a restart, and it does
 * not coordinate across replicas.** The day Pen runs two API containers this
 * becomes a shared store or it becomes decoration.
 *
 * It matters more here than it does in Simurgh, because Simurgh puts a
 * Cloudflare Turnstile in front of registration and Pen does not. Without a
 * CAPTCHA, `POST /api/auth/register/start` is an endpoint that makes us send
 * an email to any address a stranger names. These buckets are the whole
 * defence, so the per-address cap is tighter than Simurgh's.
 *
 * ── what is stored ─────────────────────────────────────────────────────────
 *
 * Never the address or the IP — only a keyed digest of it. A memory dump or a
 * heap snapshot of this process is not a list of who has been signing in.
 */
export type AuthAction =
  | 'login'
  | 'challenge.register'
  | 'challenge.reset'
  | 'challenge.resend'
  | 'complete';

interface Policy {
  /** How many are allowed in the window. */
  limit: number;
  windowMs: number;
}

/**
 * Per dimension, per action.
 *
 * `complete` has no per-address bucket on purpose, and the reason is
 * Simurgh's: an attacker who could exhaust the *address* bucket on code
 * submission would lock out the legitimate person holding a valid code. The
 * attempt counter on the challenge row is what limits guessing there, and it
 * is bound to one challenge rather than to the mailbox.
 */
const POLICIES: Record<AuthAction, { ip: Policy; email?: Policy; global: Policy }> = {
  login: {
    ip: { limit: 30, windowMs: 10 * 60_000 },
    email: { limit: 10, windowMs: 10 * 60_000 },
    global: { limit: 1_000, windowMs: 10 * 60_000 },
  },
  'challenge.register': {
    ip: { limit: 5, windowMs: 60 * 60_000 },
    // Three a day per address: the cost of getting this wrong is mail sent to
    // somebody who did not ask for it, which is how a sender loses a domain.
    email: { limit: 3, windowMs: 24 * 60 * 60_000 },
    global: { limit: 500, windowMs: 60 * 60_000 },
  },
  'challenge.reset': {
    ip: { limit: 5, windowMs: 60 * 60_000 },
    email: { limit: 3, windowMs: 24 * 60 * 60_000 },
    global: { limit: 500, windowMs: 60 * 60_000 },
  },
  'challenge.resend': {
    ip: { limit: 10, windowMs: 60 * 60_000 },
    email: { limit: 3, windowMs: 24 * 60 * 60_000 },
    global: { limit: 500, windowMs: 60 * 60_000 },
  },
  complete: {
    ip: { limit: 30, windowMs: 10 * 60_000 },
    global: { limit: 2_000, windowMs: 10 * 60_000 },
  },
};

export interface RateLimitVerdict {
  ok: boolean;
  /** Seconds until the caller may try again. Only meaningful when `ok` is false. */
  retryAfter: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface AuthRateLimiter {
  check(action: AuthAction, ip: string, email: string | null): RateLimitVerdict;
  /** Tests only. */
  reset(): void;
}

export function createAuthRateLimiter(
  secret: string,
  now: () => number = () => Date.now(),
): AuthRateLimiter {
  const buckets = new Map<string, Bucket>();

  const digest = (value: string) =>
    createHmac('sha256', secret).update(value).digest('base64url').slice(0, 22);

  /**
   * A /24 rather than a single address: a household or an office behind one
   * NAT is one caller, and an attacker with a /64 of IPv6 is not a thousand.
   */
  const network = (ip: string) => {
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
    const parts = ip.split('.');
    return parts.length === 4 ? parts.slice(0, 3).join('.') : ip;
  };

  function take(key: string, policy: Policy): RateLimitVerdict {
    const at = now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      buckets.set(key, { count: 1, resetAt: at + policy.windowMs });
      return { ok: true, retryAfter: 0 };
    }
    if (bucket.count >= policy.limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)) };
    }
    bucket.count += 1;
    return { ok: true, retryAfter: 0 };
  }

  /** Drop expired buckets so a long-lived process does not grow without bound. */
  function sweep(): void {
    if (buckets.size < 10_000) return;
    const at = now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
  }

  return {
    check(action, ip, email) {
      sweep();
      const policy = POLICIES[action];
      // Every dimension is consumed, not short-circuited: stopping at the
      // first refusal would let a caller who is over their address limit keep
      // their network budget untouched and spend it from another mailbox.
      const verdicts = [
        take(`${action}:g`, policy.global),
        take(`${action}:n:${digest(network(ip))}`, policy.ip),
        ...(policy.email && email ? [take(`${action}:e:${digest(email)}`, policy.email)] : []),
      ];
      const refused = verdicts.filter((v) => !v.ok);
      if (refused.length === 0) return { ok: true, retryAfter: 0 };
      return { ok: false, retryAfter: Math.max(...refused.map((v) => v.retryAfter)) };
    },
    reset() {
      buckets.clear();
    },
  };
}
