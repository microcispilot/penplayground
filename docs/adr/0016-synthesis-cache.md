# ADR-0016: Synthesis cache — the same sentence is bought once, behind a wrapper, and is opt-in until it is proven against the room

Status: accepted (opt-in) · 2026-09-17

## Context

ADR-0011 closed with one stage it could not credit: "TTS is always
`reused: false` (no synthesis cache exists yet)". That is the expensive
sentence in the whole design. A lesson served from the Onten memo speaks the
*identical* words the previous learner heard — same persona, same voice, same
pace — and the room still bought every one of them again. At Fish's
$15 / M UTF-8 bytes a 20-minute session is ≈ $0.22 of voice against ≈ $0.02 of
model (`docs/COST.md`), so a memo hit saved the cheap half and paid full price
for the expensive one.

## Decision

1. **A wrapper, not a change to the pipeline.** `CachingSynthesizer`
   (`packages/voice/src/server/cache.ts`) implements `SpeechSynthesizer` and
   wraps the real engine. Nothing above it — the `SayPipeline`, the room, the
   ledger, the conductor — knows a cache exists, beyond one flag on the chunks.
   Swapping the engine or turning the cache off is one line in `services.ts`.

2. **The key is everything that can change a sample**: the engine id (which
   carries the model, `fish-cloud:s2.1-pro`), the voice reference (which is
   also how a persona's language is chosen), the speed the pace asked for, the
   sample rate, the delivery tone, and the text — joined with a separator no
   field can contain and hashed with SHA-256. A model change invalidates the
   store by construction.

3. **One purchase per sentence, even under a race.** Two rooms asking for the
   same sentence at the same moment share one upstream call: the first drives
   it, the second subscribes to the same stream and both receive chunks as they
   arrive. The upstream call belongs to the shared synthesis rather than to
   whoever asked first, so one learner's barge-in cannot cut another's audio;
   it is abandoned only when the last listener leaves.

4. **Only whole syntheses are stored.** A sentence cut short by a barge-in
   leaves nothing behind, so a truncated take can never be replayed later as a
   cut-off word.

5. **A hit streams, it does not arrive in a lump.** Cached PCM is re-framed
   into the same 120 ms frames with the same contiguous clock; the first frame
   goes out with no delay at all (that is the latency a learner feels) and the
   rest are paced near realtime. The beat that follows a sentence is still the
   `SayPipeline`'s to add, so pace, ledger and replay are untouched.

6. **The books tell the truth.** A cached sentence still records its `tts`
   stage and still writes one cost line — for $0, with `reused: true` and
   `savedUsd` set to what buying it again would have cost. That is the number
   `SessionTelemetry.reuse` sums, so a memo-hit session now shows its voice as
   reuse rather than as spend, and `reuse.ttsSentencesReused` /
   `ttsSentencesGenerated` appear in Insights and in PostHog's `session_ended`.

7. **LRU, bounded by `PEN_TTS_CACHE_MB`.** An index beside the audio records
   size and last use; eviction takes the least recently used until the store is
   back inside its ceiling. A corrupt index costs a cold cache, never a failed
   boot.

8. **It ships off.** `PEN_TTS_CACHE_MB` defaults to `0`. Enabling it is one
   variable, and everything above is unit-tested — but see below.

## Why it is opt-in

Measured on the e2e stack (fake model, timed silence for a voice), a *second*
session on the same topic — where the lesson also comes from the memo, so
nothing waits for the model — delivers audio far enough ahead of playback that
the room and the client lose step: the client's player reports repeated
`PEN_PLAYBACK_SAY_STALE` for the last sentences (13 stale chunks cold, 55 warm),
and an ad scheduled at a segment boundary can arrive after the boundary has
gone by. The second symptom is fixed (the conductor now starts a late boundary
ad immediately rather than waiting for a sentence that may never come); the
first is not yet understood — the session's own ledger shows each sentence
synthesised exactly once, so the duplicate audio is not a duplicate synthesis.

Slowing the replay to 1.25× realtime did not remove it, so it is not simply a
rate. Until it is understood, the voice — which is the product — does not get a
new code path on by default. What the cache does is complete, covered by tests
(hit, miss, key, eviction, restart, concurrency, cadence, truncation,
telemetry) and costed; turning it on is `PEN_TTS_CACHE_MB=2048`, and the thing
to verify first is a warm second session with a real Fish key, listening for a
seam at a sentence boundary.

## Consequences

- With the cache on, a memo-hit session's audio cost falls to ≈ $0 and the
  session shows it: the `tts` lines read `reused: true` with `savedUsd` equal to
  what the sentences would have cost.
- The store is per node, on disk beside the ledgers. Object storage is the same
  seam if more than one node ever serves the same topics.
- Prompt-cache discipline and the memo are unchanged; this is the third leg of
  "zero redundant work", after the registry pack and the lesson memo.
- `GET /api/admin/costs` reports the cache's hits, misses, coalesced requests,
  evictions and size.
