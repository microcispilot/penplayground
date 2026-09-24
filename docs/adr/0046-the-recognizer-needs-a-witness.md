# ADR-0046: The recognizer needs a witness

Status: accepted · 2026-09-24

## Context

A replay on the test site interrupted itself. The ledger of the session
(`DjiAtYgbrH9m`) has four learner captions, and every one of them is the
expert's own sentence — *"welcome today will meet Swift values…"*, then the
refusal line itself, *"good question I can only take questions on a paid
plan…"*, which the room heard as another question and refused again. Every
`interrupt` in that ledger is stamped one millisecond before its caption.
Sessions from the 20th and 21st show the same pattern.

The room has two listeners. The `Microphone` captures with echo cancellation,
raises its bar while anything plays (`setPlaybackActive`), and confirms speech
harmonically before it calls `onSpeechStart` — that is the barge-in signal,
and it did not fire. The browser's Web Speech recognizer listens through a
capture of its own, with no echo cancellation against what the page plays
through WebAudio, and with the speakers on it transcribes the expert as
faithfully as the learner. Its final went to the conductor, which treated *a
final without a VAD start* as an interrupt ("browser STT with no local VAD"),
and the room did the same.

## Decision

**A transcript from the recognizer is believed only with the microphone as
witness while a voice is coming out of the speakers.** `RecognizerGuard`
(`packages/app/src/room/recognizer-guard.ts`) sits between the recognizer and
the conductor:

- The microphone reports `speechStart` / `speechEnd`; the session reports
  `playback(active)` whenever the expert or another participant is audible.
- A partial or final is believed when nothing has played inside the
  utterance's reach (no echo to mistake), or when the microphone confirmed
  someone speaking inside that reach: from 1.5 s before the utterance's first
  partial (the two detectors see the same onset in either order) until now.
  A final with no partial on record is measured against the last 6 s.
- What is not believed is dropped before the conductor — no interrupt, no
  caption, no question — and counted as `echo_dropped`, so a room where this
  happens a lot is visible.

The conductor's own rule stays: a final with no VAD start still interrupts.
It now only ever sees finals the guard believed, so that rule covers the
quiet-room case it was written for — a learner the microphone missed while
nothing was playing — and no longer the speakers.

## Consequences

- Barge-in is unchanged: the microphone's harmonic VAD still cancels playback
  in the same 20 ms ramp. The guard adds no latency to a witnessed transcript.
- A learner who speaks very quietly *over* the expert, quietly enough that the
  echo-cancelled microphone never confirms speech, is not heard until the
  expert pauses. That is the trade, and it is the right one: the alternative
  was every session on speakers interrupting itself.
- Server-side recognition (Electron, browsers without Web Speech) is fed by
  the microphone's own segments and never had the problem.
- `echo_dropped` is an interaction event (ADR-0011) with the dropped length.
