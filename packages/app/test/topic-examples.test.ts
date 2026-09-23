import { describe, expect, it } from 'vitest';
import { pickTopicExample, TOPIC_EXAMPLES } from '../src/lib/topic-examples.js';

/**
 * The command bar's examples, held to the rules they exist for.
 *
 * The list is the one place in the product where copy is chosen by a coin
 * toss, which means no reviewer ever sees all of it at once — whatever a
 * screenshot caught is one line in ten. So the rules are checked here instead,
 * against every line, every run. Each of these is a way the single placeholder
 * this replaced had already been got wrong:
 *
 *   · it quoted its own example, holding it at arm's length;
 *   · it asked a question, which promised an answer where the product gives a
 *     lesson;
 *   · it was the product's own seeded demo — jargon most visitors would read
 *     as "not for me".
 */
describe('the topic examples', () => {
  it('offers enough of them to be worth randomising', () => {
    expect(TOPIC_EXAMPLES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(TOPIC_EXAMPLES).size).toBe(TOPIC_EXAMPLES.length);
  });

  it.each(TOPIC_EXAMPLES)('%s is a subject, not a quoted question', (example) => {
    // No quotation marks of any kind: straight, curly, or single.
    expect(example).not.toMatch(/["“”]/);
    // A lesson, not a lookup.
    expect(example).not.toContain('?');
    // Written as the learner would write it, starting with a capital.
    expect(example[0]).toBe(example[0]?.toUpperCase());
    // Long enough to name a subject, short enough not to be clipped in the field.
    expect(example.length).toBeGreaterThan(12);
    expect(example.length).toBeLessThanOrEqual(52);
    // No leading or trailing space, and no coaching prefix.
    expect(example).toBe(example.trim());
    expect(example).not.toMatch(/^(try|e\.g\.|search|ask)\b/i);
  });

  it('picks from the list, and both ends of the range are reachable', () => {
    expect(pickTopicExample(() => 0)).toBe(TOPIC_EXAMPLES[0]);
    // The largest float below 1, which is what `Math.random()` can return.
    expect(pickTopicExample(() => 1 - Number.EPSILON / 2)).toBe(
      TOPIC_EXAMPLES[TOPIC_EXAMPLES.length - 1],
    );
    // The classic off-by-one: a list of 10 whose last item never appears.
    expect(pickTopicExample(() => 0.99)).toBe(TOPIC_EXAMPLES[TOPIC_EXAMPLES.length - 1]);
  });

  it('never returns undefined, whatever a caller’s generator does', () => {
    // Not this module's to vouch for, and an out-of-range index would render
    // `undefined` straight into the placeholder attribute.
    for (const r of [-1, 0, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const picked = pickTopicExample(() => r);
      expect(TOPIC_EXAMPLES).toContain(picked);
    }
  });

  it('spreads across the list over many draws', () => {
    // A pick that ignored its argument, or that always returned the first
    // item, would pass every check above.
    const seen = new Set<string>();
    for (let i = 0; i < TOPIC_EXAMPLES.length * 40; i += 1) seen.add(pickTopicExample());
    expect(seen.size).toBe(TOPIC_EXAMPLES.length);
  });
});
