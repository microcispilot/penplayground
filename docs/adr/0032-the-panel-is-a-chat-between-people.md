# ADR-0032: The panel is a chat between people, and the board is not a transcript

Status: accepted · 2026-09-20

Amends ADR-0019. The panel, its roster, its reactions, its collapse rule and
its drawer all stand. What it *holds* does not: the conversation list, the
typed question, and the caption's speaker name are removed.

## Context

ADR-0019 gave the room a right-hand column and filled it with everything that
had been said — the lesson's own sentences, the learner's questions, the
expert's answers, check answers and quiet system lines — and put a composer
under it whose placeholder read "Ask Ada — or just talk". The caption over the
board wrote the speaker's name before the line.

The owner, on the panel:

> "the conversation of the expert is never shown on the chat. the chat is only
> between participants and the expert never sees that and never care and this
> should not interrupt the session. you should fix this foundamentally, it is
> done wrong."

And on the board:

> "we don't need the transcripts of the expert and no labels on the board. we
> have cc, if the person wants to see the transcript, they turn that on. that's
> it. everything else should stay as natural as a real human expert would do...
> a real expert will not write his name and transcript on the board."

Both sentences are the same observation twice. A real expert teaching a room
does not keep a running transcript of themselves beside the board, does not
write their own name on the paper, and does not read the side conversation. The
panel had been built as a transcript with a question box attached; what a live
session actually wants there is what Meet, Zoom and Slack huddles put there — a
chat between the people in the room.

## Decision

### 1. Chat is a broadcast, and the rule lives in the room

`ClientChat` / `ServerChat` are modelled on `ClientReaction` line for line: the
room stamps a chat line, rate-limits it (`CHAT_MIN_INTERVAL_MS`, silently),
refuses it while an ad is on the board, caps it at `CHAT_MAX_CHARS`, and
broadcasts it to everyone **including its sender** so every client shows one
order. Nothing else in the session reads it — no floor, no plan, no pipeline,
no model, no cost.

That is enforced in `SessionRoom.chat()`, not in the panel. A UI rule would be
one refactor away from being wrong. `packages/session-engine/test/chat.test.ts`
is written as a set of *absences*, because the absences are the feature: after
a chat line the mode, the floor and the segment are unchanged, no cue is
emitted, and no `answer` thread exists.

The ledger counts a chat line as a length and never as words, for the same
reason `CLAUDE.md` forbids logging transcripts: chat is neither more nor less
private than speech.

### 2. Asking the expert is speaking

`RoomSession.ask()` and the composer's typed route to the expert are gone. The
composer sends chat: "Message everyone", `aria-label` "Message everyone in the
room", a send button named "Send to everyone in the room". A question goes the
way it goes between people — you say it, and `Conductor.onTranscript(…, final)`
gives you the floor.

`answerCheck` stays. The expert asking *you* something and you answering is not
an interruption: they stopped and waited for it.

What the microphone being unavailable means changed with it. "You can type your
question instead" was true when typing reached the expert; it is not now, so
those notices offer what is actually there — the lesson, and the captions.

### 3. Captions are subtitles, and they are off until asked for

`Caption` drew `speaker` before the line, in `--color-caption-expert` or
`--color-caption-learner`. A subtitle is the words. Both tokens and both
contrast assertions are deleted with the name; `--color-caption-scrim` and its
measurement stay.

`captionsOn` starts `false`. The CC control in the bottom bar is the only way
captions appear, and — because nothing repeats them in the panel any more — the
board now shows them whether the panel is docked, drawn over it or folded away.
ADR-0019 §4 ("Captions follow the panel") is superseded: there is nothing left
for a caption to say twice.

A replay is the exception, and not really an exception: it is a recording, its
captions are part of what the export writes into the video, and it has no CC
control to turn them back on with. `Replay.tsx` passes `on` explicitly.

### 4. The room's own lines go to the room's own status line

"Reconnecting.", "Back.", the ad's line and the end of the session were written
into the conversation as centred system rows. They have a home already:
`notice` and `RoomStatus`, the one honest-status surface, which
`apps/web/e2e/ui-states.spec.ts` already asserts on. The reconnect pair was
always duplicated there; the ad's line moved; the end is the recap panel's to
say and no longer says it twice.

### 5. What the panel looks like

Consecutive lines from one participant group under one name and one quiet
relative timestamp — broken by a different sender (by id, never by name: two
people may share one) or by a gap over `CHAT_GROUP_GAP_MS`. Your own run is a
`primary-fixed` rule down its leading edge and the name "You": distinguishable
without a wall of coloured bubbles in a 340 px column beside a board that is
the content. An empty chat says what the chat is and where the expert is, so
nobody types a question into it.

The scrolling list is `role="log"` with `tabIndex={0}`: a region a mouse can
scroll has to be one a keyboard can scroll (WCAG 2.1.1, and axe's
`scrollable-region-focusable` at *serious*, which `e2e/ui-a11y.spec.ts` fails
the build on).

## Consequences

- `packages/app/src/room/conversation.ts` is deleted, and the store's
  `conversation` with it. `chat.ts` replaces both.
- Five specs that drove a typed question now ask by voice through
  `apps/web/e2e/speech.ts`, which installs a fake `SpeechRecognition` before
  navigation. Everything from `onresult` inwards is the product's own path.
- `question_typed` stays in `InteractionName` and in the Insights labels. No
  new session can produce one; sessions already in the ledger can, and Insights
  renders those.
- A session with no guests still shows the panel. Whether it should is the next
  decision, not this one.
