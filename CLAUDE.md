# Working rules for Pen Playground

Read `docs/SPEC.md` for what the product is and how it is built. These are the
rules for *how work is done here*. They bind every session and every agent.

## Onten is mocked — read this before you touch knowledge, retrieval or context

**We do not have Onten.** `packages/onten` is a mock of it, and the whole project
proceeds on that assumption. Onten is not a search engine and not a knowledge
source. It is a **memory**, with exactly two abilities:

1. **Give it information** — `onten.learn({ title, documents, evaluation })`.
   One documented way in; the corpus builder streams the same documents through
   `compiler.startProgressiveCompilation` / `addSource` as it finds them.
2. **Retrieve in under 20 ms** — `runtime.query(input)` returns a schema-faithful
   `AnswerContext` for *any* question, with no re-thinking, inside
   `ONTEN_LATENCY_BUDGET_MS = 20` (`packages/contracts/src/onten.ts`). That is
   Onten's own number, measured at 20,000 knowledge units by
   `packages/onten/test/latency.test.ts`.
   
   That test asserts two different things, and the distinction matters. The
   **absolute** budget is checked only on a machine close enough in speed for
   the number to mean something: building the same corpus takes 1.5 s on a
   laptop and has taken 29 s on a CI runner, and a p95 of 0.97 ms became
   20.87 ms with no code change. The **regression** bound is checked
   everywhere, normalised by that same index build, and it is far tighter than
   the budget because we now clear the budget twentyfold. Do not "fix" a
   latency failure by loosening a bound — find what got slower, as the fuzzy
   matching change did.

**Simulated content is acceptable. Its contract is not.** Until the real SDK
lands, units, scores and packs are approximations and nobody worries about that.
The wire shapes, the status rules, the ingestion path and the latency budget are
real, tested, and not negotiable. A question about material Onten was never given
gets `missing` or `partial` — never an invented `sufficient`.

**Never implement an Onten capability outside `packages/onten`, and never put a
Pen capability inside it.** If you are about to index, rank, select, score,
chunk, or decide what evidence answers a question — stop: that is Onten's, and it
goes behind the interface. If you are about to store something our own model
generated (a lesson, its audio, a session card) — stop: that is ours, and it goes
anywhere but there. `packages/onten` depends on `contracts` alone, so it stays
deletable in one commit the day the SDK arrives.

`docs/ONTEN-BOUNDARY.md` rules on every capability in the system with file and
line, lists the drift already fixed, and names the mock's known limits.
ADR-0019 is the decision; it supersedes ADR-0003.

## Confirm, never assume

Nothing is changed on a belief. Before a change is made, the belief behind it is
checked against the thing itself.

- **Read before you write.** Open the exact region you are about to edit. Never
  patch from memory, from a summary, or from what another report said the file
  contains.
- **Check the interface you are calling.** Confirm a function, flag, event name
  or response shape in the installed version — the `.d.ts` in `node_modules`,
  `--help`, or the official documentation — rather than recalling it. Versions
  here are pinned; the API in your memory may belong to a different one.
- **Observe the cause before you fix it.** Reproduce the failure and keep the
  evidence: the failing assertion, the log line, the measured number. A
  suspicion is not a diagnosis, and a fix for an unobserved cause is a guess.
- **Prove the dismissal.** "Pre-existing", "environmental", "unrelated" and
  "flaky" are claims. Reproduce the failure on an untouched checkout of the same
  commit, or investigate it as yours.
- **Grep before you remove.** A rename or deletion is checked against the whole
  repository, including tests, docs, `deploy/`, nginx configuration and the
  desktop host.
- **Run it before you report it.** Every claim of done comes with the command
  that was run and what it printed. No "should now work", no "presumably".
- **Say what you could not confirm.** When something cannot be verified in this
  environment, leave it unchanged, name it in the report, and say what would
  confirm it. Unverified is an acceptable outcome; unverified-and-unmentioned is
  not.

## Prove it with tests

Every change ships with a test through the module's interface, and a live probe
when a real provider is involved (model, Fish Audio, the speech relay, Stripe,
Sentry, PostHog). The report lists the tests by name with their results and the
measured numbers. `pnpm verify` and the Playwright suite are green before
anything is called finished.

### Real credits are for correctness, never for taste

Spending real model and voice credits is allowed, and expected, to prove that
something **works**: the integration path end to end, a provider's real
response shape, a real session reaching real audio. Run those, and report the
numbers.

They are **not** for deciding whether the result is any *good*. Whether a voice
sounds human, whether a pause lands, whether a sketch reads at a glance,
whether the pace feels right — no test and no model may return a verdict on
those. They are the owner's, and only a person can give them. Prepare the
thing, say plainly what you could not judge, and leave the judgement open
rather than filling it with a confident guess.

So: "the lesson ran, first audio at 1.2 s, 14 cues, no errors" is ours to
report. "It sounds natural" is not ours to claim.

## The product bar

Apple- and Google-grade. The mockup defines flows, not visual quality. UI work is
reviewed as screenshots in light and dark, empty and populated, at desktop,
tablet and phone widths, before it is called done.

Calm, never alarming: no consent banners, no draft badges, no lock icons on
gated rows. Limits are one friendly sentence with a link. The AI disclosure is
one quiet line.

Wine is the brand. The owner's palette (ADR-0052) is wine `#68113C` for pills
and the mark's delta, brand `#8A1A41` for buttons — Sign in, Start, the
lesson's progress and the board's ink, the ordinary, confident places —
brand-light `#AE2A58` for highlights, glow `#CB688C` for an edge, blush
`#DFBDC7` for a card's frame, mint `#D0F5EB` for a headline on a dark ground
and berry `#95214E` for the middle of a gradient. By night the brand fill is
the glow, because the wine is 2:1 on a dark page; every number is measured in
`packages/design/test`. The error role is the owner's `#ED424A`, laddered so
it can be read, and it is close enough to the brand that *colour alone never
carries the message*: an error says what went wrong in words, and the red is
only agreement with the words. Reach for `error` when something actually
broke — a request that failed, a field that will not take what is in it.
Ending a session, liking a lesson and an ad having played are ordinary states
and wear neither.

Latency is the product. No state where the expert is silent and the board is
still for more than two seconds without an honest status line.

## Release

Commit to `main`. Deploys and `release/web/<semver>` branches happen only when
the owner asks. Never commit `.env`. Never log transcripts or spoken text.
