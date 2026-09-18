# ADR-0017: The lesson's voice is stored beside the lesson — and a learner's own words never are

Status: accepted (opt-in) · 2026-09-17

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

## Why it ships off

`PEN_TTS_CACHE_MB` defaults to `0`. With a *warm* store, the free plan's
between-segment ad stops opening — reproducibly: run `apps/web/e2e/ads.spec.ts`
twice against one server and the first run reaches the ad overlay while the
second never mounts it.

What that is *not*: the audio. The server's frames are well formed (no repeated
chunk ids, nothing after `final`, read back from a session's own ledger), the
client plays sentences in order with no bank rejections, and the
`PEN_PLAYBACK_SAY_STALE` warnings are the player correctly discarding audio for
a sentence it cancelled when the room changed mode mid-sentence — which happens
without the store too, just less often. It is a scheduling race between a
pending boundary ad and the sentence whose end is meant to start it.

So: the store is complete, correct and covered (hit, miss, lesson scoping,
supersession by text, voice and pace, eviction, restart, concurrency, cadence,
truncation, the privacy boundary, the audio bound), and the money it saves is
real — but it costs free-plan ad revenue in a way that is not yet understood,
and revenue is not something to lose quietly. `PEN_TTS_CACHE_MB=2048` turns it
on, and on a deployment without ads it is pure win today.

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
