import { describe, expect, it } from 'vitest';
import { withDelivery } from '../src/room.js';

/**
 * The room is the one door a sentence goes through (ADR-0047): what it
 * broadcasts never carries a bracket, and the voice gets the cues.
 */
describe('withDelivery', () => {
  it('splits a say into shown text and spoken text', () => {
    const say = withDelivery({
      type: 'say',
      id: 's1',
      text: 'Here is [emphasis] the point. [break] Watch.',
      tone: 'warm',
    });
    expect(say).toEqual({
      type: 'say',
      id: 's1',
      text: 'Here is the point. Watch.',
      tone: 'warm',
      spoken: 'Here is [emphasis] the point. [break] Watch.',
    });
  });

  it('adds nothing to a sentence without cues, and leaves other events alone', () => {
    expect(withDelivery({ type: 'say', id: 's1', text: 'Plain.', tone: 'neutral' })).toEqual({
      type: 'say',
      id: 's1',
      text: 'Plain.',
      tone: 'neutral',
    });
    const done = { type: 'done' as const };
    expect(withDelivery(done)).toBe(done);
  });

  it('never leaves the shown text empty', () => {
    const say = withDelivery({ type: 'say', id: 's1', text: '[break]', tone: 'neutral' });
    expect(say.type === 'say' && say.text.length > 0).toBe(true);
  });
});
