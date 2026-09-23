/**
 * The examples the command bar shows when it is empty.
 *
 * One is picked at random per visit. The owner asked for that — *"these should
 * come randomly, maybe you can use Jev for that, or if jev is not a good
 * option, have multiple hardcoded ones"* — and Jev is not a good option, for
 * three reasons worth writing down rather than re-deciding later. It is a
 * decisions model: a multiple-choice classifier, billed per call, reached over
 * the network. Asking it would put a round trip in front of the first paint of
 * the most-looked-at element on the page, spend money on every visit including
 * every crawler's, and add a dependency whose timeout would have to be handled
 * — to choose one item from a list, which is what the line below does for free
 * and offline. A model is for judgement. This is not judgement.
 *
 * ── what makes a line belong here ──────────────────────────────────────────
 *
 * The rules are the ones the single placeholder was already written to, and
 * they are why this is a curated list rather than anything generated:
 *
 *   · It is the thing itself, written the way a person would write it. No
 *     "Try", and **no quotation marks** — a placeholder that quotes its own
 *     example is holding it at arm's length, when the field should read as
 *     though the topic is already in it.
 *   · It is a *subject*, not a trivia question. This product teaches a lesson
 *     with an expert and a board; a line that invites a single answer sets the
 *     wrong expectation about what is on the other side of Start. So no
 *     question marks.
 *   · It is something *most* people recognise. The placeholder was once the
 *     product's own seeded demo, "how Transformers work in LLMs", which reads
 *     to almost everybody as jargon they are not the audience for.
 *   · It draws well on a board, because that is what the learner is about to
 *     be shown.
 *
 * `test/topic-examples.test.ts` holds every one of those against every line,
 * so a cheerful addition cannot quietly break the rule the list exists for.
 */
export const TOPIC_EXAMPLES = [
  'Fundamentals of music theory',
  'How calculus actually works',
  'The golden ratio, and where it really shows up',
  'Fundamentals of probability',
  'The mathematics behind encryption',
  'Compound interest, and why it runs away',
  'Bayes’ theorem, in plain English',
  'The Pythagorean theorem, and why it is true',
  'How a neural network learns',
  'The shape of a normal distribution',
] as const;

export type TopicExample = (typeof TOPIC_EXAMPLES)[number];

/**
 * One example, at random.
 *
 * `random` is injected so the test can pin a choice and so the boundaries are
 * checkable: a generator returning exactly 0 and one returning the largest
 * float below 1 must both land inside the list. `Math.random()` is documented
 * as `[0, 1)`, but the index arithmetic is the kind that is wrong by one for
 * years without anybody noticing, because the last item simply never appears.
 */
export function pickTopicExample(random: () => number = Math.random): TopicExample {
  const index = Math.floor(random() * TOPIC_EXAMPLES.length);
  // Clamped rather than trusted: a caller's generator is not this module's to
  // vouch for, and an out-of-range index here would render `undefined` into
  // the placeholder attribute.
  //
  // The finite check is not belt-and-braces — `Math.min` and `Math.max` both
  // *propagate* NaN rather than clamping it, so a generator returning NaN got
  // past a clamp that looked complete and indexed the list with NaN. The test
  // caught it; the arithmetic never would have.
  const safe = Number.isFinite(index) ? Math.min(Math.max(index, 0), TOPIC_EXAMPLES.length - 1) : 0;
  return TOPIC_EXAMPLES[safe] as TopicExample;
}
