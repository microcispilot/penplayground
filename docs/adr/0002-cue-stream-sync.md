# ADR-0002: Voice/board synchronisation via a deterministic cue stream with the audio clock as master

Status: accepted · 2026-09-16

## Context
The expert's voice and the board must stay in sync on every client, with
pause/resume/barge-in that feels human, for 1–12 participants, and be replayable
and exportable later. Pixel-streaming the board is expensive and non-editable;
free-running two timelines drifts.

## Decision
- The model emits **JSON Lines**: one small cue object per line
  (`say`, `board`, `check`, `note`), validated per line with Zod. First usable
  cue arrives after the first line, not after the whole response.
- Each `say` is sent to TTS immediately (sentence-level streaming). Audio chunks
  carry the `sayId` and an `audio_clock_ms` (Fish NDJSON contract).
- Each `board` op carries an **anchor** (`with:<sayId>` / `after:<sayId>` /
  `now`). The client **conductor** schedules the op against the sentence's
  measured audio duration: with-anchored ops are paced to complete by the end
  of the sentence (never faster than the human writing speed constant; if the
  sentence is too short the op continues into the next sentence rather than
  snapping).
- The audio clock is the master clock. Board, captions and progress derive from
  it. Pause stops the clock; resume continues from the exact sample.
- Barge-in: the conductor fades audio (20 ms), freezes the board mid-stroke and
  records the **resume point** locally; the server is told afterwards. Zero
  round-trips on the critical path.
- The server broadcasts the same cue stream to all room participants; every
  client renders identically. The **recording ledger** is the cue stream plus
  audio chunks plus participant events, which makes replay and export
  deterministic.

## Consequences
Board rendering is client-side and cheap; the wire is tiny; multi-user needs no
canvas sync for the expert's writing. Participant-drawn annotations (later) use
tldraw sync as a separate layer.
