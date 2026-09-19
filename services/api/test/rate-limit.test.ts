import { describe, expect, it } from 'vitest';
import { clientAddress, clientKey, RateLimiter } from '../src/rate-limit.js';

/**
 * The limiter guards the two unauthenticated routes, so it is also the one
 * map an anonymous caller can grow. Both properties are locked here: it
 * limits, and it forgets.
 */
describe('RateLimiter', () => {
  it('allows up to the limit inside the window and refuses beyond it', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1_000, () => now);
    expect([limiter.allow('a'), limiter.allow('a'), limiter.allow('a')]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.allow('a')).toBe(false);
    // A different key has its own budget.
    expect(limiter.allow('b')).toBe(true);
    // The window slides: once the first calls age out, the caller is allowed again.
    now += 1_001;
    expect(limiter.allow('a')).toBe(true);
  });

  it('forgets keys whose window has passed instead of growing forever', () => {
    let now = 0;
    const limiter = new RateLimiter(5, 60_000, () => now);
    for (let i = 0; i < 5_000; i += 1) limiter.allow(`10.0.${i >> 8}.${i & 0xff}`);
    expect(limiter.size).toBe(5_000);

    // One call after the window has elapsed sweeps every stale key…
    now += 60_001;
    limiter.allow('10.0.0.1');
    expect(limiter.size).toBe(1);

    // …and a caller that keeps calling is kept, with only its live hits.
    for (let i = 0; i < 4; i += 1) {
      now += 1_000;
      expect(limiter.allow('10.0.0.1')).toBe(true);
    }
    expect(limiter.allow('10.0.0.1')).toBe(false);
    expect(limiter.size).toBe(1);
  });

  it('keeps refusing without growing the record of a caller that is over budget', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    expect(limiter.allow('flood')).toBe(true);
    for (let i = 0; i < 1_000; i += 1) expect(limiter.allow('flood')).toBe(false);
    now += 1_001;
    expect(limiter.allow('flood')).toBe(true);
  });
});

describe('clientKey', () => {
  const req = (headers: Record<string, string>) => ({
    header: (name: string) => headers[name],
  });

  it('prefers X-Real-IP, which only our own edge can set', () => {
    expect(clientKey(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': 'spoofed' }))).toBe(
      '203.0.113.7',
    );
  });

  it('falls back to the first X-Forwarded-For hop, never the whole chain', () => {
    expect(clientKey(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toBe(
      '203.0.113.7',
    );
  });

  it('is a fixed key when there is no proxy, and is never unbounded', () => {
    expect(clientKey(req({}))).toBe('local');
    expect(clientKey(req({ 'x-real-ip': 'x'.repeat(500) })).length).toBe(64);
  });

  it('is the same resolution the visit record uses, with a bucket name instead of null', () => {
    // One opinion about which header names a client (ADR-0028): the per-IP
    // session cap, the beacon limiter and `site_visits.ip_address` all read
    // it here, and `clientKey` differs only in never being null.
    for (const headers of [
      { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': 'spoofed' },
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
      { 'x-real-ip': 'x'.repeat(500) },
    ])
      expect(clientKey(req(headers))).toBe(clientAddress(req(headers)));
    // The one place they part: no edge at all.
    expect(clientAddress(req({}))).toBeNull();
    expect(clientKey(req({}))).toBe('local');
  });
});
