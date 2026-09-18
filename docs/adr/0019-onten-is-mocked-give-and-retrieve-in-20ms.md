# ADR-0019: Onten is mocked — its two abilities are *give it information* and *retrieve in under 20 ms*, and both are enforced

Status: accepted · 2026-09-18 · **supersedes ADR-0003**

## Context

ADR-0003 got the *shape* right: one interface, schema-faithful AnswerContexts,
progressive first use, nothing outside `packages/onten` touching retrieval. What
it never wrote down was what Onten actually **is**, and so the boundary drifted
in small ways nobody could point at, and the one promise that makes the whole
product affordable was never tested.

The owner said it plainly:

> "Onten is the SDK that is helping us compile and prepare the data we give it
> and provides us with the abilities to access answer to any questions in sub
> 20 ms or faster. That is like a human brain, the brain will remember anything
> it learned and given to and then for any of those, it can immediately give you
> the answer context ready to use. It must be given some information to be able
> to answer, exactly like a human that when they are given some information, when
> asked later, without the need to re-think or process, they can access and give
> those information immediately. […] That is fine if the information are not
> accurate right now, and simulated, we don't worry about that until real Onten
> is integrated."

Two abilities, then. Not a search engine, not a knowledge source, not a
generator: a **memory**. Give it something; ask about it later; get it back
without re-thinking.

Onten's own documents agree and put a number on it. From
`onten-answercontext-examples/01-memo-hit-repeated-question.yaml`:

> "The model does not decide to search — the search already happened, correctly,
> **inside 20 ms**."

And they say what the memo is, which we had got wrong:

> "the memo never caches an answer. It caches the SELECTION." (CTX-MEMO-01)

Measured before this change, on a generated 20,000-unit corpus with a Zipfian
vocabulary: **p50 21.3 ms, p95 41.4 ms, max 78.8 ms**. The mock was three to four
times over Onten's number at a size the product will really reach, and nothing in
the repo would have noticed — `CONTEXT_BUDGET` bounds tokens, not time.

## Decision

### 1. Onten is mocked, and the mock is held to the contract, not to the content

Simulated units, simulated scores, simulated packs — all fine, and they stay fine
until the real SDK lands. What is not simulated: the wire shapes, the status
rules, the ingestion path, and the latency budget.

### 2. `ONTEN_LATENCY_BUDGET_MS = 20` lives in `packages/contracts`, beside `CONTEXT_BUDGET`

Not a target: a test. `packages/onten/test/latency.test.ts` builds 40 packs ×
500 units = 20,000 knowledge units from a Zipfian vocabulary (so a few terms are
in nearly every unit and most are in almost none, as in prose), fires 400 queries
whose term sets are all distinct — so the memo cannot flatter the result — and
fails the build if p50 or p95 crosses the budget.

`MockContextRuntime` times **every** `query` on the wall clock — which is what
the host paid, and is not the same as `assemblyNs`, the runtime's own view of
assembly, which is zero on a speculation hit. `RuntimeMetrics` gained
`elapsedMs`, `budgetMs` and `overBudget`; `runtime.latency()` reports p50/p95/max
and the count of breaches. Every breach is an event the room records; the first
of a session is also a Sentry error, with fixed message text and the numbers in
its context, so a degraded process raises one issue rather than one per turn.
Timings stay in the run manifest and never enter the AnswerContext, per example
03.

### 3. What made it fit: select before you score

The mock now precomputes the document frequency of every term when it compiles
the index, and a query is answered from the terms that **discriminate**: words
the corpus knows first, rarest of those first, capped at four, with anything
matching more than 2 % of the corpus dropped while a rarer word survives. Words
the corpus has never heard fill the remaining places and only when nothing better
is left — a rule that looks fussy and is not: an unknown word has a document
frequency of zero, so ranking on frequency alone makes "um" look like the most
precious term in the question (see §8). Scoring every unit that happens to
contain the word "the" is what a search engine does; a memory goes straight to
the shelf.

Measured after, same corpus, same queries: **p50 0.72 ms, p95 2.59 ms,
p99 9.32 ms, max 14.9 ms**. Under a fully loaded machine (all fourteen packages
testing in parallel) the tail reaches ≈ 25 ms once in four hundred calls, which
is why the test holds p50 and p95 to the budget strictly and `max` to twice it: a
garbage collection is not a retrieval regression, but a moved tail is still worth
seeing.

### 4. The Canonical Question Memo (CTX-MEMO-01) is implemented — it was missing

The 8,432nd learner to ask the same question now skips retrieval and the selector
entirely. The memo stores the **selection** — which units, and the score each
earned — never an answer, and it is **re-admitted against the live index on every
hit**, because "a stored selection is a candidate set, never an admitted set". It
is shared across every runtime in the process, which is the whole point of it, and
keyed by the pack signature plus a bounded, non-sensitive question key: topic,
selection band, requested shape, and the question's own words in their own order.
No principal id, no learner state, ever. A republished pack has a different signature and so is simply a different
memory — there is no invalidation step to forget. Measured: **p50 0.09 ms**.

Compiled indexes are shared the same way, so a second room teaching the same packs
pays nothing to configure (2.3 s cold → 0 ms warm).

### 5. There is one way to give Onten information

`onten.learn({ title, documents, evaluation })` — hand it documents, get back the
pack they became, answerable immediately. Everything else is that same path with
the documents arriving one at a time: the corpus builder still streams through
`compiler.startProgressiveCompilation` / `addSource`, and pack seeding now goes
through `learn` instead of driving the compiler by hand.
`packages/onten/test/memory.test.ts` does exactly what the owner described: gives
it a fact, asks about it, gets it back.

### 6. It answers only from what it was given

A question about material never ingested returns `missing` or `partial` with
`score: 0` and `mayAuthorizeConsequentialDecision: false` — never an invented
`sufficient`. Pinned by test: every span returned for an off-topic question is
checked to be text from the document that was actually ingested.

### 7. The boundary is written down, with a verdict per capability

`docs/ONTEN-BOUNDARY.md` lists every capability in the system as **Onten's**,
**Pen's** or **drift**, with file and line. Drift found and fixed:

- **Pack seeding minted its own canonical ids, domains and scopes.** It now asks
  `registry.resolveTopic` and hands the document to `learn`. The host does not
  name things in Onten's namespace.
- **`TopicResolution.lessonMemoId`, and `MockRegistry` depending on Pen's lesson
  memo.** A Pen concept welded into Onten's registry contract — and dead: nothing
  read it. Removed; `MockRegistry` takes only a pack store.
- **A second copy of `titleCase`** in `services/api/src/language.ts`. Now calls
  Onten's, so the display title cannot drift from the id the registry keys on.
- **The lesson memo lived inside `packages/onten`.** It caches *generated lesson
  text* — sentences our model wrote from context Onten supplied. Onten never saw
  it and will never store it. Moved to
  `packages/session-engine/src/lesson-memo.ts`, with the distinction from
  CTX-MEMO-01 written at the top of the file so nobody moves it back.

One drift is **knowingly retained and recorded**: cross-language canonical-title
resolution (`services/api/src/language.ts`, `TopicIntake`) is really
`resolveTopic`'s job, and we do it with a model call because the mock's registry
is lexical. Moving it would make `packages/onten` depend on `@pen/llm` and put a
multi-second network call inside the module whose contract is sub-20 ms. It is in
the boundary document with the exact instruction for deleting it when the SDK
lands.

### 8. What an adversarial review of this change then caught

A fresh-context review of the diff, with its own probes, found four defects in
the work above. They are fixed here, and they are worth recording because each
is a way a fast answer can still be a wrong one.

- **A word the corpus has never heard looked like the rarest word of all.** The
  selector ranked purely on document frequency, and an unknown term scores zero
  — so four filler words were enough to evict every real term from a four-term
  selector. Measured: "wait hold on, um, yeah, why divide by square root of d"
  came back **`missing`** from a pack that plainly answered it. Learners speak;
  they do not type a search box. Known words are now ranked ahead of unknown
  ones, and `memory.test.ts` asks the same question four ways a person would
  actually say it.
- **The memo key was a bag of words.** Sorted content terms with stop words
  removed, which made "is the glaze firing hotter than the bisque firing" and
  the same words reversed one key — and "should I open the kiln" the same key as
  "should I **not** open the kiln". The key is now the question's tokens in
  order. Fewer hits, and the ones it has are the right ones.
- **Qualification could hang for ever.** A throw inside `maybeQualify` — a full
  disk on the pack write is the realistic one — left `background` pending with
  nobody to resolve it, and `void`ed the rejection. It now always settles.
- **The breach report printed the wrong number and would have stormed Sentry.**
  It interpolated the runtime's internal assembly time (zero on a speculation
  hit) rather than the wall time the budget is judged on, and embedded a float
  in the message, so every slow turn would have filed a separate issue. The
  manifest now carries `elapsedMs`, the message is fixed text with the numbers
  in the context, and only the first breach of a session becomes an error.

The same review also found the registry's similarity score normalising against
the wrong pack — "Work in LLMs" resolved as a certain `hit` (1.000) on a
transformers pack — which would have suppressed pack seeding for ever and
mis-resolved learners' topics. And it found that pack seeding, on a `partial`,
filed the seed under the *other* pack's canonical id, producing two qualified
packs with one id. Both are fixed. Three smaller things went with them: spans
from an unqualified pack are now tiered `unverified_live_source` rather than
claiming a review that never happened, the speculation buffer is bounded (one
utterance left 39 entries behind), and `packRefs` is snapshotted at `configure`
so a payload cannot cite revision 2 in one field and revision 1 in another.

## Consequences

- Swapping the mock for the real binary stays a one-adapter change, and
  `packages/onten` is now deletable in one commit: it contains Onten and nothing
  else.
- The latency promise is a build gate. A change that makes retrieval think harder
  fails `pnpm verify` instead of reaching a learner as a pause.
- Repeated questions and repeated topics cost approximately nothing, which is the
  economics the product was designed around — and it is now measured rather than
  assumed.
- The mock is thinner than the real thing in known, listed ways (the qualification
  gate does not run its own eval set; topic resolution is lexical; no dense
  retrieval, no pack layering, no typed facts). They are enumerated in
  `docs/ONTEN-BOUNDARY.md` rather than discovered later.
