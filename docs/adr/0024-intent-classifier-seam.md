# ADR-0024: A provider seam for intent, and a confidence a turn can act on

Status: accepted · 2026-09-19 · **partly superseded by ADR-0025**

> ADR-0025 makes `PEN_INTENT_PROVIDER` a runtime setting, changes its default
> from `model` to `jev`, and stops `jev` without `OPENROUTER_API_KEY` being
> fatal — the room falls back to the session model and says so once, rather
> than refusing to build. Everything else below still stands.

## Context

Every learner turn passes through `SessionRoom.decide()`. `classifyLocally`
(`packages/session-engine/src/brain.ts`) places most of them for free with
regular expressions — backchannels, plain questions, the six spoken commands
in their common phrasings. What it cannot place falls through to one
structured-output call on the session's own model: `schema: IntentOutput`,
`maxOutputTokens: 40`, `purpose: 'intent'`.

That call sits between the learner's last word and the first sound back, and
it is the slowest thing on that path that produces no audio: measured at a
655 ms median to its **first token** alone. It also cannot express doubt. A
completion constrained to six enum values always emits one of the six, and a
coin flip looks exactly like a reading — so the room has no way to treat
"that's probably an `end`" differently from "that is certainly an `end`", and
`end` finishes the session.

TypeSafe's Jev is a *decisions* model on OpenRouter: named multiple-choice
questions over a described situation, answered with a choice, a distribution
and a confidence. It is not on `/chat/completions` (the gateway refuses it by
name) and it is not in `GET /api/v1/models`; it answers only on
`POST /api/alpha/decisions`.

## Decision

1. **A provider seam, like STT and TTS.** `PEN_INTENT_PROVIDER=model|jev`
   selects an `IntentClassifier`
   (`packages/session-engine/src/intent.ts`); `createIntentClassifier`
   (`services/api/src/intent.ts`) builds it exactly as `createRecognizer`
   builds a recognizer, and the room takes it as one optional dependency.
   `model` is the default, so nothing changes until a deployment opts in, and
   that one line turns it off again.

2. **The layering follows the packages that already exist.** `@pen/llm` owns
   the decisions wire — auth, budget, response validation, pricing
   (`jev.ts`), and knows nothing about lessons. `@pen/session-engine` owns the
   taxonomy, the prose state, the mapping back to `IntentOutput` and the
   confidence rule. `classifyLocally` stays untouched and stays in front:
   turns it can place still cost nothing and make no network call.

3. **Three steps down, each safer and slower than the one above.**
   Heuristics → hosted classifier → model call → `{ intent: 'question',
   command: 'none' }`. Every step down is reached only by the one above
   declining, and the last cannot fail. An error, a timeout, a malformed
   answer or an unrecognised choice is recorded and falls to the model. **A
   dead classifier must not end a session.**

   Two things follow from the hosted call being the room's only pause between
   hearing the learner and answering them. A session that ends inside it stops
   the turn there — otherwise an ended room would buy a model call and a whole
   answer for nobody — and it is recorded as neither a Sentry issue nor a
   failed stage, because a session closing is not a provider failing. And each
   classifier is handed the room read at the moment it is called, never a
   snapshot taken before that pause: a check-in can land inside it, and a stale
   `pendingCheck` reads the learner's answer to it as a new question.

4. **Both questions in one round trip, and the command answer is only read
   when the intent is `command`.** A second call would double the hot-path
   cost for exactly the utterances most likely to be commands, and the one
   failure it would prevent — "sorry, what did you just say?" answering
   `repeat` to the command question while the turn is a `clarify` — is
   prevented by the mapping instead, whatever the model says. Spelling `none`
   out as an explicit criterion fixed that case at the source too (measured:
   `repeat` without it, `none` with it), so both guards are in place.

5. **A confidence gate, at 0.70** (`INTENT_MIN_CONFIDENCE`). Below it the turn
   falls to the model rather than acting. Over 22 live decisions on this
   taxonomy the answers landed in two clumps with nothing between them —
   0.40, 0.52, 0.53, 0.68, then 0.74 through 1.00 — and 0.70 sits in the
   empty band. A command is only as trustworthy as its weaker half, so its
   confidence is `min(intent, command)`: "certainly a command, unsure whether
   it means pause or end" must do neither.

   The threshold sits at the top of the band, not the bottom, because the two
   outcomes are not symmetric. Falling through costs a few hundred
   milliseconds and one model call; acting on a misread `end` costs the
   learner their session.

6. **Its own stage and its own cost component** (`intent`, ADR-0011), so
   Insights and PostHog see this spend beside every other provider's.
   `withIntentTelemetry` records one `intent` stage sample and one cost line
   per hosted call; the model path stays the single `llm` stage with
   `purpose: 'intent'` it has always been, counted once. The `room.intent`
   observer event now carries `via` and `confidence`.

7. **A 600 ms budget** (`INTENT_TIMEOUT_MS`). Across 74 live calls the
   latencies split in two: a warm connection answers in 128–390 ms (p50
   ~200 ms), and the first call of a process takes 410–518 ms on TLS and
   connection setup. 600 ms clears the slowest warm call by 1.5×, and the API
   is a long-lived process that keeps the connection, so every classification
   but the first is a warm one. A cold start that trips the budget falls back
   to a correct answer once and is warm afterwards. Past this the call has
   already lost its race with the fallback it exists to beat.

8. **A refusal is a status code and nothing else.** A thrown error reaches
   Sentry, and a gateway's validation error may quote the request that caused
   it — and our request carries the learner's own words. `DECISION_HTTP_<n>`
   is the whole message; the body goes only to an explicit `onRefusal` hook,
   which the probe wires to its console and a session never does.

9. **`OPENROUTER_API_KEY` is its own key.** OpenRouter is a different gateway
   and a different account from OpenAI; the per-plan `OPENAI_API_KEY_*` keys
   are never reused for it, and readiness refuses to serve without it when
   `PEN_INTENT_PROVIDER=jev`. The model id is pinned to `typesafe/jev-1.13` —
   `typesafe/jev-latest` exists in TypeSafe's own console but OpenRouter
   rejects it.

## Measured

`pnpm --filter @pen/api intent:probe`, 14 real utterances across the taxonomy,
2026-09-19:

| | |
|---|---|
| Latency (3 runs) | p50 168 / 206 / 221 ms · warm max 390 ms · cold first call 416–518 ms |
| Cost | $0.0000297 per classification (input only; output is free) |
| Failures | 0 of 14 |
| Above the threshold | 11 of 14 in every run — the three below were consistently `end` (0.44–0.53), `pause` (0.52–0.56) and one question (0.68) |
| Placed locally, no call at all | 5 of 14 |

Against the model path's 655 ms median *first token*. Prices are in
`packages/contracts/src/pricing.ts` and were confirmed against the endpoint's
own `usage.cost`: 685 input tokens reported $0.00002877, which is
685 × $0.042 / 1M exactly.

## Consequences

- Turning it on is one environment variable, and so is turning it off. No
  code path is deleted: the model call remains both a provider in its own
  right and the floor under the other.
- An unsure turn is slower than it is today, not faster: it pays the hosted
  call *and* the model call, serially. The worst case — the full 600 ms
  budget, then the model's 655 ms median first token — is ~1.25 s before the
  acknowledgement is even queued, which is inside the two-second bar but with
  little room. If that case turns out to be common, the answer is to start
  the model call at ~250 ms rather than only once the hosted one gives up;
  it is not done here because it spends a model call on every slow turn.
- The empty confidence band is an observation, not a law. If answers start
  arriving in the 0.68–0.74 gap the threshold moves **up**; the same
  asymmetry that chose it chooses that direction.
- Whether these classifications are *good* is not settled here. The numbers
  above are measured; the taxonomy judgement is the owner's.
