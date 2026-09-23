# ADR-0039: Where a decisions model beats a language model — check-ins graded by Jev, feedback the expert already had

Status: accepted · 2026-09-23

## Context

The owner asked for Jev to be used *"in the proper places that it's best for
… places that it's better to be used instead of an LLM, or deterministic
texts / hardcoded voice texts."*

Jev (TypeSafe's System One model, ADR-0024) answers typed questions over a
described state — a **choice** with a distribution and a confidence, a
**score** over ordered levels, a **noul** (a yes/no probability) — in one
parallel pass, 70–500 ms, $0.042 per million input tokens and free output.
It writes nothing. That is the whole test for where it belongs: a step is
Jev's when the room needs a *decision* and already has, or can have without
a model, the *words*. Every model call in a session was read against it:

| Call (`purpose`) | What it produces | Verdict |
|---|---|---|
| `intent` | which of six things a turn is | **Jev, since ADR-0024** (heuristics first, model floor) |
| `grade` | a verdict **and** one spoken sentence | **Jev decides; the sentence is deterministic** — this ADR |
| `intake` | an English title for a non-English topic | a translation is generation; stays a model call, cached per topic |
| `plan`, `lesson`, `turn` | the lesson and the answers | generation, and Onten decides the evidence — never Jev's |
| `recap` | 4–6 bullet points | generation; the deterministic fallback (segment goals) already exists and whether it is *good enough* is the owner's call, not this ADR's |
| `session_meta`, image | card copy, thumbnail | generation |
| out-of-scope (`missing`) | whether to redirect | already deterministic — Onten's status decides, the line is hardcoded (ADR-0037's neighbour) |
| bridges, acknowledgements, invitations, hand lines | what the expert says at seams | already hardcoded and localized in `brain.ts` |

Grading was the one call that bundled a decision with prose it did not need
to write. A check-in cue already carries the question, the reference answer
and the explanation, written when the lesson was and shared with every
learner through the memo; the only new thing per learner is whether their
words match. Yet each answer cost a structured-output completion (~1 s to
first token, ~120 output tokens) that decided *and* composed "Exactly — a
vector is just a list of numbers. Let's move on." A teacher does not compose
"that's it". They say it.

## Decision

1. **A grader seam, like the classifier's** (`packages/session-engine/src/grading.ts`).
   `Grader.grade({ question, expected, options, answer, explain })` returns a
   verdict, a confidence and its usage. `JevGrader` asks one **choice**
   question — `correct` / `partial` / `incorrect`, each criterion spelled
   out — over a state whose last line is the learner's words (the same
   discipline as intent and the prompt-cache prefixes).

2. **The feedback is the expert's own line.** `checkFeedback(verdict,
   explain, seed, language)` in `brain.ts`: a verdict in a breath, the
   check-in's own `explain`, and "let's keep going" — in fifteen languages,
   cycling like the acknowledgements. A language without a table returns
   null and the model composes as before, rather than an English line in a
   Spanish lesson.

3. **Two steps down, the model is the floor.** `SessionRoom.gradeCheck`:
   hosted grader → (confidence ≥ `GRADE_MIN_CONFIDENCE`, a feedback line in
   this language) → else the one model call it always was. A timeout, an
   unknown choice, a session ending mid-grade, an unsure answer: all fall
   through, none can fail the check-in. The evidence rule is unchanged: a
   `unverified_live_source` session still withholds the verdict.

4. **The same floor as intent, 0.70**, for the same asymmetry: falling
   through costs the model call this always made; acting on a misread
   verdict tells a learner they were right when they were not. Measured by
   `pnpm --filter @pen/api grade:probe` (below); if the band closes it moves
   up, not down.

5. **Its own switch, the same key.** `PEN_GRADE_PROVIDER=jev|model` (runtime
   setting, default `jev`), built on the one memoised decisions model the
   classifier uses (`createDecisionsModel` in `services/api/src/intent.ts`),
   TypeSafe direct when `PEN_TYPESAFE_API_KEY` is set. No key → null →
   model, said once in the log, as ADR-0025 ruled for intent. `/api/health`
   reports `grade: jev|model` beside `intent`.

6. **Priced as the provider it is.** A hosted grade is one `intent` stage
   sample and one `intent` cost line with `purpose: grade`; the model path
   keeps its `llm` stage with the same purpose. Insights and PostHog see the
   spend beside every other provider's and never sum the two rates. The room
   says `room.grade { verdict, via, confidence }` and `room.grade_unsure`.

## Measured

`pnpm --filter @pen/api grade:probe`, twelve real answers to two check-ins
(one with options, one free), TypeSafe direct, 2026-09-23 — see the report
in the session that shipped this; the numbers are recorded in
`tasks/todo.md`. Whether the verdicts are *right* is the owner's judgement;
the probe prints them beside what a teacher would say and decides nothing.

## Consequences

- One model call fewer per answered check-in, and the reply is a breath
  away instead of a second: the verdict arrives in Jev's 200–400 ms and the
  first spoken sentence is a stored line, not a completion.
- `GradeOutput` and `gradeMessages` stay: they are the floor.
- Tests: `packages/session-engine/test/grading.test.ts` (the seam, the
  telemetry, the lines in every language) and `grade-room.test.ts` (the room:
  a confident verdict skips the model; unsure, failed and unknown-language
  grades reach it; the check result and the spoken line are what the
  learner gets).
- Not done here, on purpose: Jev for the recap (a taste decision the owner
  should make), a **noul** in front of `turn` asking "is this answerable from
  the evidence" (that is Onten's status, and putting a second opinion beside
  it is exactly the drift ADR-0019 forbids), and Jev in the browser (a
  200 ms network call has no place in the client's barge-in path).
