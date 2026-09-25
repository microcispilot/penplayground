# ADR-0050: A check-in is a moment the lesson stops for

Status: accepted · 2026-09-24

Extends ADR-0010 (the beat after a check-in question) and ADR-0039 (the
hosted grader).

## Context

The owner, after a replay on the test site:

> *"The title is changing to what the expert is saying… the expert should
> say let's do a quick check and should ask that question and read the
> options like a real human and work with the user through that… a session
> should not be continued while user is thinking… the quick check popup
> should be shown in the middle… this whole quick check should be
> configurable… the board gets blurred after submitting."*

What was true:

- The card's title was the expert's **latest caption**, not the question:
  the client had no question text, so it showed whatever was being said.
- The options were never spoken; the card just appeared with them.
- While the card was up the client kept **playing what it had banked**: the
  room stopped buying sentences, but the two or three already bought played
  on, so the lesson walked ahead of a learner who was thinking.
- After an answer the room went `thinking`, and the conductor dims the board
  for `thinking` because that is what it does when somebody else has the
  floor. A check-in is not that.
- Nothing let a learner turn check-ins off.
- The end-of-session panel appeared inside the inline player box, where it
  was cramped and said less than the watch page around it.

## Decision

### The room asks the way a teacher does

Every sentence the model writes is held for one event, so a check can claim
the sentence that asked it. When it does, the room speaks three sentences
where the model wrote one: an **introduction** of its own ("Quick check —
let's see if that landed", rotated by segment, in the lesson's language
where a line exists and English otherwise; id `s9i`), the **asking
sentence** as written, and the **options read out** ("A: … B: … C: …", one
letter each; id `s9o`). The check is pointed at the options sentence, so the
card appears when the last option has been heard. This is the room's doing,
not the prompt's, so lessons written and memoised before this decision are
introduced just the same. The prompt still asks the model to write the
question in one sentence and leave the options to the room.

The card carries `question`, attached by the room: the asking sentence when
it is a question, or the sentence before it when an older lesson pointed the
check at a statement. The client never guesses it from a caption.

### The lesson waits

When the check is reached, the room cancels the pipeline — nothing further
is bought or banked — and the conductor, on `checking`, pauses playback and
drops its bank the way a pause does, keeping the board readable with the
question on it. The answer is graded, the feedback line is spoken (correct,
or not, and why), and the lesson resumes from the sentence after the check,
re-taken as after any pause. `thinking` and `answering` that follow a
check-in never dim the board.

### The card is the thing on screen

Centred over the board, the question set in the title size, the options
under it with the same letters the expert just read, and a line to type or
speak an answer. One card, one moment.

### An account can turn it off

`participants.check_ins` (migration 0019, default on). `PATCH /api/me
{ checkIns }` sets it for an account and refuses a visitor, who has no
account to keep it on. Settings shows *Quick checks* to a signed-in learner.
The room is built with the host's preference; with it off, the check and the
sentence that asked it are dropped together — the sentence is held for one
event so a following check can claim it — and the lesson runs straight
through. The lesson memo keeps every event, so the choice is this learner's
and costs the next learner nothing.

### The player is resumed on every road back

The player's pause is a flag only its own resume clears, and the conductor
resumed it only after an ad. A host's own pause, a discussion, and now the
check-in's hold all left the player mute for the rest of the session — which
is what "the expert never spoke again" was. The conductor now pauses and
resumes the player through one flagged pair, and every road back to playing
(the host's resume, the verdict after a check, the lesson after a pause or a
discussion) resumes it; an ad keeps charge of it while it is up.

### A pause mid-turn is honoured, later

A pause pressed while the expert is answering, thinking, listening, or
holding a check is not refused: the turn finishes and then the lesson holds
instead of going on; a resume before that undoes it. The player's toggle is
decided by its own phase and the room's mode together, so the two can no
longer disagree about what a press means.

### The card lives inside whatever is fullscreen

When an element is fullscreen the browser draws its subtree alone: a card
that is that element's sibling is not hidden by a style, it is not drawn at
all. The card is portalled into `document.fullscreenElement` while there is
one, and stays on the board otherwise — so it is there whichever element the
learner made fullscreen.

### Inline, an ended session hands the page back

The watch page is the recap — the description, the comments, Up next — so
the inline player hands the page back the moment the session ends, and the
end panel stays for the room screen alone.

## Consequences

- `CheckEvent.question` is optional on the wire and always set by the room.
- Replays of stored lessons gain the options sentence: it is generated at
  emit time, never memoised, so the memo is unchanged.
- The check-in's longer beat (ADR-0010) now follows the options sentence.
- Tests: `check-ins.test.ts` (engine), the conductor's hold, the API
  preference, and the updated pace and room tests.
