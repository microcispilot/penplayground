import { describe, expect, it } from 'vitest';
import { avatarHue } from '../src/ids.js';

/**
 * A person has one colour.
 *
 * There were two hashes for it: the room's, which coerced to uint32 and took
 * the modulus once, and the header's, which took it on every step. They look
 * the same and are not — so the same participant was one colour on their
 * account chip and another on their tile in the room, which are the two
 * places somebody sees their own avatar at the same moment.
 *
 * The old client hash is written out below rather than described, so the
 * difference between them is a measured number and not a claim.
 */
const oldClientHash = (id: string): number => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

describe('avatarHue', () => {
  it('is a hue, for every id this product mints or a person types', () => {
    for (const id of ['p_1', 'p_anonymous_0001', 'host-1234', 'مینا', '👩‍🚀', '']) {
      const hue = avatarHue(id);
      expect(hue, id).toBeGreaterThanOrEqual(0);
      expect(hue, id).toBeLessThan(360);
      expect(Number.isInteger(hue), id).toBe(true);
    }
  });

  it('is stable: the same id is always the same colour', () => {
    const id = 'p_anonymous_0001';
    expect(avatarHue(id)).toBe(avatarHue(id));
    expect(avatarHue(id)).not.toBe(avatarHue(`${id}x`));
  });

  /**
   * The defect, kept as a measurement. If someone ever reintroduces a second
   * hash "that does the same thing", this says how wrong that goes.
   */
  it('disagrees with the hash the client used to carry, which is why there is one now', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `p_${i.toString(36)}_${i * 7919}`);
    const differing = ids.filter((id) => avatarHue(id) !== oldClientHash(id));
    expect(
      differing.length / ids.length,
      'most ids landed on two different colours',
    ).toBeGreaterThan(0.5);
  });
});
