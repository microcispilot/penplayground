# ADR-0055: The lesson waits for the board, the card comes with the announcement, and mute keeps the device

Status: accepted · 2026-09-25

Extends ADR-0046 (the recognizer's witness), ADR-0050 (a check-in is a
moment the lesson stops for) and ADR-0051 (one hand, one scale, a board on
a wall).

## Context

The owner, testing the deploy of 2026-09-25:

> *"when making the mic on or off, there's a change in voice for a short
> moment like a very small interruption … the board looks very unnatural and
> the center of that looks very out instead of the border standing out like a
> real board … the quick check is shown very late, it should be shown when
> the expert starts talking about it … the lines are too far apart … some of
> the writing is not properly spaced horizontally, `Int Double UInt` looks
> like `IntDoubleUInt` … when the session starts, the expert already wrote on
> the board and started talking … ensure the board is loaded and then start
> the session."*

## Decisions

### The lesson waits for the board

`RoomSession.start()` primes the player inside the click, then waits for
the board chunk's download (`preloadBoard()`, started at mount) before it
connects, bounded by `BOARD_READY_WAIT_MS` (1 s) so a download that never
lands cannot hold the lesson. Nothing is generated, and so nothing is
spoken or written, until the board can mount at once. Nothing is shown for
the wait: the room paints the wall and an empty frame while it connects,
and the portrait page with "Getting the material together" and
"Connecting…" is gone from that phase (it remains for a topic that is
genuinely being prepared). The first cut waited for the *mount* with a 4 s
bound, which left that page on screen for the full four seconds; the owner:
*"I just wanted you to add only like a second delay and then the session
starts without adding or showing any visuals."*

`LazyBoard.ready` stays for the replay's export, which does wait for the
mount.

### The card comes with the announcement

The room attaches `announcedBy` to a check: the id of the sentence it
announces the check with ("Quick check — let's see if that landed"). The
conductor shows the card when that sentence *starts* and arms it — the
lesson held, an answer taken — when the options sentence ends, exactly as
before. Between the two the card is read-only: the options are disabled and
the answer line hidden. The card carries no "Quick check" label and the
board no "Answer out loud, or pick an option" hint — the owner had both
removed; the expert has just said what this is.
A state update while the announcement plays does not take the card down; a
barge-in does, with the sentence it rode on.

### Mute keeps the device

The microphone toggle no longer releases the capture device. Opening and
closing it reconfigures the audio hardware, which is where the hitch in the
expert's voice came from. Off now means what it means on a call: the track
disabled, the recognizer stopped, the published track withdrawn from the
room, and the device kept until the session ends (`releaseMic`). The ad
gate's own mute is combined with the learner's, so an ad's end cannot
unmute someone who muted themselves. The preference is unchanged: a learner
who turned the microphone off keeps it closed from the start, with no device
open at all.

The hitch itself could not be heard here; the change removes its cause.
The owner is the judge of whether it is gone.

### A flat board in a plain frame

The paper's wipe highlights and vignette are gone: they lit the middle and
dimmed the edges, which read as a spotlight, not a surface. What remains is
the frame's shadow a few pixels into the surface. The frame is one colour
all round with a hairline of light on its top edge and a darker lip, the
way a real frame is; the two-tone bevel made two sides read as a different
material.

### Tighter lines, real word gaps

`lineGap` 18 → 10 and `CODE_PADDING` 18 → 6: a run of code lines used to
sit 81 units apart at the code size, and sits 49 apart now. A word gap is
never narrower than `WORD_GAP_MIN_EM` (0.32 em): Patrick Hand's own space is
barely a fifth of an em, which is why words ran together. Wrapping,
measuring and placing all go through the same floor.

### The board writes in one colour, and code in an editor's face

Every emphasis — title, accent, warning, muted, the underline, a note's
label — is the chalk or marker the learner chose: *"markers/chalk fonts
should stay the same on the board … only for the code you should use some
purplish and greenish colours that code editors use."* The emphasis
tokens are still declared for the families' tests, but nothing on the
board reads them. Code alone takes colour, from Shiki's One Light and One
Dark Pro (purple keywords, green strings), and is set in the editor's face,
JetBrains Mono, at a 0.6 em advance — the owner's second ruling on the
code face, superseding ADR-0051's "code in the hand". The "is thinking…"
pill is gone as well.

### The small things

The room bar shows the mark, not a stand-in glyph. A session card's edge is
a hairline, and the lift is for hover only. Clearing the suggested expert
leaves a "Random expert" chip in its place, so the field never reads as
silently "anyone".

## Consequences

- `CheckEvent.announcedBy` is optional on the wire; lessons memoised before
  this have it attached at emit time like `question`.
- `packages/conductor/test`, `packages/session-engine/test/check-ins.test.ts`,
  `packages/board/test/glyphs.test.ts` and `packages/app/test` carry the
  new assertions; the Playwright suite covers the start, the toggle and the
  card end to end.
