# ADR-0017: The lesson's voice is stored beside the lesson — and a learner's own words never are

Status: accepted · 2026-09-17 (on by default 2026-09-18)

## Context

ADR-0011 closed with one stage it could not credit: "TTS is always
`reused: false` (no synthesis cache exists yet)". That is the expensive
sentence in the whole design. A lesson served from the Onten memo speaks the
*identical* words the previous learner heard — same persona, same voice, same
pace — and the room still bought every one of them again. At Fish's
$15 / M UTF-8 bytes a 20-minute session is ≈ $0.22 of voice against ≈ $0.02 of
model (`docs/COST.md`): the memo saved the cheap half and paid full price for
the expensive one.

The owner's framing settled the shape of the fix:

> "Maybe saving the voice alongside the sessions, and only new questions and
> interactions can use the API, otherwise the session is cached — everything
> until it's changed. The only things we don't cache are user questions and
> interactions during the session, because those will be different for
> different users and we also want to keep privacy of the users."

That draws a line that is both an economic one and a privacy one, and they
fall in exactly the same place.

## Decision

1. **A session has two halves, and only one of them is reusable.**

   | | Shared material | This learner's session |
   | --- | --- | --- |
   | Words | the lesson plan and its sentences (Onten memo) | the question, the answer, the check-in verdict |
   | Voice | stored beside the lesson (this ADR) | synthesised fresh, every time |
   | Kept for | every future learner of this topic | this session's own ledger, for observability |

   The lesson is the same for everyone who asks for the topic, so it is bought
   once. Everything a learner prompts is theirs: different for each of them, so
   caching it would buy nothing, and *about* them, so keeping it would be the
   wrong thing to do. Both halves are still recorded in the session's ledger,
   where ADR-0011's observability, research and analysis look — they are simply
   not reusable material.

2. **The voice lives with the words it speaks.**

   ```
   <PEN_DATA_DIR>/lesson-voice/<canonicalId>/<band>/<expertId>/
     manifest.json          what is stored, and for which version
     L0.s3.<take>.pcm
   ```

   One directory per lesson as it is actually taught. Content and audio stay in
   step because they are addressed the same way, and a lesson can be inspected,
   copied or deleted as one thing.

3. **Identity is the version, so there is no invalidation step to forget.**
   A sentence's `take` is a hash of everything that decides a single sample:
   its text, the engine and model, the voice, the speed, the sample rate and
   the delivery tone. Re-write one sentence and its hash changes: that take
   stops being used and is deleted the next time the lesson is spoken, while
   every untouched sentence is still a hit. Change the persona's voice, move
   the pace or switch the model, and the same mechanism retires exactly what it
   should.

4. **The seam is a wrapper.** `CachingSynthesizer` implements
   `SpeechSynthesizer` and wraps the real engine, so the `SayPipeline`, the
   room, the ledger and the conductor are unchanged. The only thing above it
   that knows is the room, which marks a sentence with the lesson it belongs
   to — and the absence of that mark is what keeps a learner's words out.

5. **One purchase per sentence, even under a race.** Two rooms teaching the
   same lesson at the same moment share one upstream call and both stream from
   it as it arrives. The call belongs to the shared synthesis rather than to
   whoever asked first, so one learner's barge-in cannot cut another's audio.
   Only a whole sentence is stored: a barge-in leaves nothing that could later
   be replayed as a cut-off word.

6. **A stored lesson streams; it does not arrive in a lump.** Same 120 ms
   frames, same contiguous clock, first frame with no delay at all, the rest
   paced near realtime. The beat after a sentence is still the pipeline's to
   add, so pace, ledger and replay are untouched.

7. **The books tell the truth.** A stored sentence still records its `tts`
   stage and one cost line — for $0, with `reused: true` and `savedUsd` set to
   what buying it again would have cost. `SessionTelemetry.reuse` sums it, and
   `reuse.ttsSentencesReused` / `ttsSentencesGenerated` reach Insights and
   PostHog's `session_ended`.

8. **The lookahead is bounded by seconds, not sentences.** Found while building
   this: the pipeline ran three sentences ahead of the learner whatever their
   length, and three long ones are a minute of speech — more than the client's
   30 s player bank, whose rejections would stall the room and the learner on
   each other. It now stops at 20 s of banked audio as well. That was a latent
   flaw with any fast provider (Fish delivers ≈ 4.5× realtime); a stored lesson
   is simply what made it reachable.

## What it measures

Teaching the same topic twice with real Fish (`s2.1-pro-free`), the fake model
so both tellings speak the identical sentences, and the store on:

| | first telling | second telling |
| --- | --- | --- |
| Sentences from the store | 0 of 2 | **2 of 2** |
| Time to first audio | 107,642 ms | **106 ms** |
| First chunk, per sentence | 107,496 ms / 42,810 ms | **1 ms / 1 ms** |
| Bytes synthesised | 146 | 146 (none bought) |

The first telling is slow because the free Fish tier queues — fair use, no SLA —
which is exactly the day a learner should not have to wait through twice.

**It is the same audio, not a re-rendering.** The stored sentence came back
byte for byte identical (610,294 bytes, 6.919 s at 44.1 kHz, matching the
duration the room reported), on a contiguous clock: 58 frames, zero
discontinuities, the final frame flagged. What the second learner hears is what
the first learner heard.

**And only the lesson is there.** After both tellings the store held exactly
two files — the two lesson sentences. The learner's question and the answer
composed for it were never written down, which is the line ADR-0018 draws and
`packages/session-engine/test/lesson-voice-boundary.test.ts` pins.

Money, at these sizes, is small because the demo lesson is two short sentences:
146 bytes is $0 on the free model and $0.0022 on `s2.1-pro`. The shape is what
matters — a real 20-minute session is ≈ 15 KB of text, ≈ $0.22 of voice
(`docs/COST.md`), and the second learner of that topic pays none of it.

### What had to be fixed first

Turning this on exposed a real deadlock, and it was not in the store. The
pipeline will not run more than 20 s of audio ahead of the learner, and that
budget is released only as each sentence is reported heard. A check-in is the
one turn that neither cancels the lesson nor reports anything heard — so the
seconds held by sentences the client had *already thrown away* (every conductor
drops its bank the moment the learner takes the floor) stayed on the room's
books, and with the budget full the answer could never be synthesised at all.

Measured, on the same warm store, with one line differing:

| | ad shown | lesson progress | ad events |
| --- | --- | --- | --- |
| before | no | stalls at the boundary (17) | none |
| after | yes | 24 of 25 | requested → loaded → started → ended |

The room now tells the pipeline the bank is gone when the learner takes the
floor, which is exactly what every client has already done.

## Consequences

- With it on, a memo-hit session's audio cost falls to ≈ $0 and the session
  shows it: the `tts` lines read `reused: true` with `savedUsd` equal to what
  the sentences would have cost.
- The store is per node, on disk beside the ledgers. Object storage is the same
  seam if more than one node ever serves the same topics.
- Sentences are evicted least-recently-heard first, across lessons, so a lesson
  nobody asks for fades out one sentence at a time while a popular one keeps
  what is actually being heard.
- Together with the registry pack and the lesson memo, this is the third and
  last leg of "zero redundant work": a second learner of a topic pays for
  neither the words nor the voice — only for their own questions.
