/**
 * In-memory sliding-window limiter per key; enough for one node, replaced by
 * Redis behind the same interface.
 *
 * The map is swept: without it every distinct key (one per client address for
 * the auth routes) stays for the life of the process, so a week of traffic —
 * or one afternoon of spoofed `X-Forwarded-For` values — is a slow leak. Keys
 * are dropped as soon as their window is empty, and a full sweep runs at most
 * once per window, so the cost is O(keys) per minute, not per request.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastSweep = this.now();
  }

  /** True when the call is within budget (and counted); false when it is over. */
  allow(key: string): boolean {
    const now = this.now();
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);
    const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (fresh.length >= this.limit) {
      // Keep what is left so the window keeps sliding, but never grow it.
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }

  /** How many keys are being tracked; the leak this class exists to prevent. */
  get size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      const fresh = times.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}

/**
 * Where a request came from, as this deployment is willing to believe it.
 * `X-Real-IP` is set by our own edge
 * (`deploy/nginx/pen-playground.conf.example`) from the peer address, so it
 * is the trustworthy one; nginx *appends* to `X-Forwarded-For`, whose first
 * hop is whatever the client sent, so it is only a fallback and only ever its
 * first entry — the whole header would let one caller mint unlimited distinct
 * buckets and slip past the limit.
 *
 * Null when neither header is set, which is every request that reached this
 * process without going through the edge (a local run, a test, a container
 * talking to itself). **This is the one opinion in the codebase about which
 * header names a client**: the per-IP session cap, the beacon limiter and the
 * visit record all resolve an address through here, so they can never end up
 * disagreeing about who a caller is (ADR-0028).
 */
export function clientAddress(headers: {
  header(name: string): string | undefined;
}): string | null {
  const real = headers.header('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = headers.header('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : null;
}

/**
 * The key an unauthenticated caller is limited by: their address, or `local`
 * for a request that arrived without one — one shared bucket rather than no
 * limit at all.
 */
export function clientKey(headers: { header(name: string): string | undefined }): string {
  return clientAddress(headers) ?? 'local';
}
