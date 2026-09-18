# ADR-0019: The lesson begins before the outline is finished, and the card waits for the first sentence

Status: accepted · 2026-09-18

## Context

`docs/SPEC.md` asks for "first expert audio < 1.5 s after Start (p50)" on a
prepared topic. A session on the deployed site (`LDMH64nPHc7x`, a warm knowledge
pack) took about ten seconds, and the stage samples said exactly where it went:

```
t=1ms     resolve    11ms     pack hit
t=34ms    llm      5658ms     purpose "plan"   ← nothing else happens for 5.7 s
t=5713ms  llm      5848ms     purpose "lesson", firstTokenMs 1165
t=5728ms  llm      3404ms     purpose "session_meta"  ← on the same connection
t=6880ms  tts      3527ms     first sentence, fish-cloud s2.1-pro-free
```

Reproduced here on three cold sessions of the seeded topic with real keys
(`openai` + `fish-cloud`), the same three costs, in the same order: a plan call
of 3.5–4.8 s that everything waits for, a lesson call whose first token takes
another 1.0–1.6 s, and a voice engine whose first chunk takes 0.5–1.6 s. Time to
first audio: 7947 / 5778 / 5396 ms.

Three separate things are wrong, and only one of them is the voice.

## Decision

### 1. The expert starts composing segment 1 while the planner is still writing

A plan is one object — `{ title, promise, segments[] }` — but it is *written* in
that order, and strict structured output holds to schema order. The title, the
promise and segment 1 are therefore final several seconds before the last
segment is. Segment 1's model call needs nothing else.

So `planLesson` became `streamPlan`, which returns two promises instead of one:
`opening` (title, promise, segment 1) and `plan` (the whole thing). It is the
same request at the same price; the room simply awaits the opening, sends
segment 1's call against it, and only then awaits the plan. The two calls
overlap; nothing is spoken until the plan is whole.

Measured over four cold runs: the opening lands at 38–53 % of the plan call, and
the lesson call's first token is now entirely hidden behind the plan's tail. The
first cue is emitted 1–3 ms after the plan lands, where it used to be emitted
1.0–1.6 s after, so time to first audio is `plan total + TTS first chunk` with
the lesson call costing nothing at all.

The options that were weighed and rejected:

- **An extra "first segment only" call.** Another round trip on the critical
  path, another price, and a reconciliation problem when the real plan disagrees
  with the segment already taught.
- **A speculative lesson call against the resolved topic, reconciled later.**
  The only way to reconcile is to discard what was said or to say it anyway. The
  learner must never hear a sentence the final plan contradicts, and this design
  can only promise that by not saying anything yet.
- **Going live on the opening alone** (phase `live`, `RoomState.plan` filled in
  a beat later). Worth about another 1.2 s, and it costs the client contract:
  the progress dots read `0` and then jump to the real count, the chrome shows the topic
  and then swaps in the plan title, and audio reaches the player while the
  screen still says "planning the session". `phase: 'live'` continues to mean
  "the plan is complete", and everything downstream — dots, check-in placement,
  the ledger, replay — is untouched.

What segment 1 gives up is the list of segments that follow it, which it cannot
have yet. Its prompt says so plainly ("the rest of the outline comes after this
segment: cover this segment's goal only") rather than pretending the outline is
there. The session's promise, which *is* known, carries the arc.

`seconds` is the one field of segment 1 that can still move: the final plan
scales every segment so the session adds up to the target length, and that
factor is not known until the last segment is written. It reaches the model only
as a "this many sentences" hint, never as something the learner hears.

### 2. The catalogue card waits until the learner can hear the expert

ADR-0013 says the card copy and sketch run in the background and the first audio
never waits for them. That was true of the *ordering* and false of the effect:
the job was enqueued the moment `room.start()` resolved — which is the moment
the plan lands — so its 3–4 s call ran alongside the one call the learner was
actually waiting for, on the same provider and the same connection.

`SessionRoom` now exposes `firstAudio`, resolved when the session's first audio
frame goes on the wire (or when the room ends without one), and the room
registry awaits it before enqueuing the card. Same background work, same
ADR-0013 contract, no contention.

### 3. The voice engine is measured, not guessed at, and the fix is to arrive warm

Twenty sentences through `fish-cloud:s2.1-pro-free` on an idle machine, five
short opening lines and five lesson-length ones per run:

| | min | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| run 1 | 395 | 611 | 716 | 716 |
| run 2 | 392 | 439 | 594 | 594 |

Short lines: 604 ms and 448 ms mean. Lesson-length lines: 515 ms and 467 ms
mean. **Sentence length does not move the free tier's first chunk**, so the
prompts were left alone: instructing the expert to open with a short line would
have changed how it sounds and bought nothing. Under real session load the same
engine returned 456–1773 ms, and production has been seen at 3527 ms; the free
tier queues, and no amount of pipeline work hides that.

`SayPipeline` was already free of batching: a sentence is enqueued the instant
the parser emits it and drains immediately, so synthesis starts on the first
`say` event with nothing between them. That was verified, not changed.

What does close the gap is arriving warm. A prepared topic already reuses
everything on the *second* telling — the plan and the sentences from the Onten
memo, the audio from the lesson voice store (ADR-0017). `scripts/prewarm-packs.ts`
(`pnpm --filter @pen/api packs:prewarm`) makes the product the second learner: it
teaches each seeded pack once over the ordinary room protocol, so the words and
the voice are stored under exactly the keys a learner's session would use.

## Consequences

Measured here, three cold sessions each, the seeded topic, real keys, a cleared
data directory per run:

| | before | after |
| --- | --- | --- |
| time to first audio | 7947 / 5778 / 5396 ms | 4924 / 4036 / 4683 ms |
| lesson call's first token | on the critical path | hidden behind the plan |
| `session_meta` starts at | t = 4813 / 3919 / 3541 ms | t = 4918 / 4029 / 4677 ms |

After pre-warming the seeded pack, a first-ever learner of that topic reached
first audio in **108 ms**, with every stage reused: plan, segment, card and
voice.

The honest floor for a *cold* prepared topic on this stack is **the plan call
plus one voice first-chunk** — about 4.0–4.9 s here, and it is now almost
entirely the plan call. It is above the 1.5 s bar and no further pipeline work
will bring it under: the remaining time is one model call and one voice call,
back to back, with nothing left to overlap. Closing it needs either a faster
outline (a smaller `PEN_LLM_OUTLINE_MODEL`, or `PEN_LLM_SERVICE_TIER=priority`)
or paid Fish capacity — or, for the topics that matter most, arriving warm,
which is what `packs:prewarm` is for and which already meets the bar with room
to spare.
