import { ClientMessage } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { WS_LIMITS } from '../src/app.js';

/**
 * A message family with no bucket is not rate limited at all.
 *
 * The table used to cover the chatty families and miss the expensive ones:
 * `auth` verifies a JWT, `join` reads the session row and builds a seat,
 * `progress` walks every lesson sentence between reports and moves the TTS
 * lookahead, and `utterance_start`/`end` open and close a **paid**
 * recognition. The binary branch — upstream audio — had no ceiling whatever,
 * and it is the one that streams.
 *
 * `allow()` returns `true` for a family it does not recognise, which is the
 * right default for a handler and the wrong one to rely on, so the coverage
 * is asserted here rather than hoped for. Adding a message to the protocol
 * and forgetting its bucket now fails this test, with its name in the error.
 */
const ALIASED: Record<string, string> = {
  // Both are answered by a person, take a turn, and share one bucket.
  check_answer: 'question',
};

describe('WS_LIMITS', () => {
  const kinds = ClientMessage.options.map((o) => o.shape.kind.value as string);

  it('has a bucket for every message a client can send', () => {
    const missing = kinds.filter((kind) => !(WS_LIMITS[ALIASED[kind] ?? kind] ?? false));
    expect(missing, `no rate limit for: ${missing.join(', ')}`).toEqual([]);
  });

  it('covers upstream audio, which is not a message kind at all', () => {
    // The binary branch. 20 ms frames at 50 a second is 3,000 a minute, so a
    // client streaming normally never reaches this and one replaying a
    // capture as fast as it can does.
    expect(WS_LIMITS.audio).toBeDefined();
    expect(WS_LIMITS.audio?.limit).toBeGreaterThan(3_000);
  });

  it('names a window for every bucket, and a limit that could be reached by a flood alone', () => {
    for (const [family, rule] of Object.entries(WS_LIMITS)) {
      expect(rule.windowMs, family).toBeGreaterThan(0);
      expect(rule.limit, family).toBeGreaterThan(0);
    }
  });

  /** The transcript bucket is the chatty one and must stay well above the rest. */
  it('lets interim transcripts stream', () => {
    expect(WS_LIMITS.transcript?.limit ?? 0).toBeGreaterThan(WS_LIMITS.question?.limit ?? 0);
  });
});
