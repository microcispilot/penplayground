# ADR-0051: One hand, one scale, a board on a wall

Status: accepted · 2026-09-24

Extends ADR-0034 (the board's surfaces) and ADR-0041 (chalk and marker).

## Context

The owner, after a replay:

> *"The board fonts are not really good. It uses very big in something and
> very small in something that doesn't make sense. Use properly consistent
> fonts and follow the human user interface and font guidelines. Also you
> don't need to put swift on every code related thing on the board… Why is
> the code font not the same font as the rest? It should follow the same
> font family everywhere on the board except things that are not possible
> with that font… The frame of the board is really not looking good and I
> want some white wall look, spacing should be added around the board so it
> simulates a wall and a board on it."*

What was true: the title was 58 world units and code 17, a ratio of 3.4;
handwriting was Eraser, code was a monospace and prose a sans; every code
block wore a language badge; the frame filled the viewport edge to edge.

## Decision

### One scale

`TYPE` is 34 / 28 / 23 / 24 / 22 (title, writing, label, code, prose): the
title a little over the writing, the writing 1.2× a label, code a touch
larger than the writing because a monospaced-looking line in a hand is read
character by character. A board reads as one hand at one distance, not a headline over
footnotes. The camera's legibility floor is 14 CSS pixels for the writing,
which at this scale still lets a 1200-wide line fit a phone.

### One hand

Code and prose are set in the hand too. The face lacks a few glyphs —
`<`, `>`, `[`, `]`, `}` — and for those alone the stack's next face steps
in, per glyph. That is what "except what the font cannot do" means. Code
blocks and prose are sized with the hand's own advance, and the language
badge is gone: the expert said what the lesson is in.

### The hand is Patrick Hand

The owner, after two rounds of thinning Eraser: *"let's replace the current
one with Patrick Hand."* Patrick Hand (OFL, via fontsource) is a marker hand
of normal weight with lowercase, so nothing is eroded any more — the erosion
stays in the code at zero for a heavier face — and the board reads as
writing rather than chalk shouting. It covers Latin, punctuation and the
brackets Eraser lacked; the arrows and the maths it lacks still come from
Caveat, per glyph, as before. Its letters are narrower (advance 0.43 of the
size against Eraser's 0.63, measured with opentype.js) and it has
descenders, so the advance ratio, the line height (1.3) and the scale moved
with it: 40 / 28 / 23 / 21 / 21. Eraser's files stay in `packages/design/
fonts`, unloaded. Code and prose keep the face's own weight.

### A page is a frame, hung from its leading edge

The page is 1600 × 900, the shape of the player's box. The camera keeps the
whole current page on screen at whatever zoom the screen allows — below the
legibility floor if it must — and follows only what leaves the page. That is
how a video shows its whole frame in a small box and a big one. The page
check comes before "is the new writing already on screen": at mount the zoom
is 1 and the first line sits inside that small viewport, which was exactly
when the inline player never framed the page and then cropped it. A box that
changes size re-fits the page.

When the screen is wider than the page, the page hangs from its **leading
edge** — the left for left-to-right writing, the right for right-to-left —
with the spare board on the trailing side. Centring a narrower page put the
first word of every line near the middle of the board.

### Writing starts from the right for a right-to-left lesson

The layout thinks left to right and mirrors what it hands out: placements,
note slots and registered refs, around the content area. A Persian or
Arabic lesson fills from its right margin and its columns walk left; the
executor, the shapes and the camera do not know the difference. The board
takes its direction from the session's language and can change it
mid-lesson without moving what is already on the page.

### Code is written as lines, and the next column starts after the widest thing

Every snippet used to be drawn inside a hand-drawn rectangle: the owner,
*"it does not look good, second, it takes so much space."* Code is now bare
lines with a hair of padding; the colouring says it is code, the hand says
who wrote it. And the next column starts a gap after the widest thing in
the current column rather than a fixed column width away — a column of
short lines used to leave half the board empty beside it — with a floor
(240) so a column of one word never puts the next on top of it, and the
full column as the ceiling.

### The card scales with its box

The check-in card is sized from the board frame's **measured width** (a CSS
variable set by a resize observer): one card that is small in a small player
and larger in full view, never one that needs scrolling in a short box. It
was a container query for one release, and the layout containment that
comes with `container-type` left the card unpainted in the room screen until
a resize (the owner: *"it wasn't there first"*; the ledger: the room in
`checking` for four and a half minutes before the answer). Nothing on the
board wants containment; the measurement has none.

### A board on a wall

Plaster: a cream-white with a fine grain (a turbulence filter in a data URI,
so it ships with the stylesheet), darker towards the edges the way a lit
wall is, in the room and inline, so the framed board reads as an object
hanging in a room. The wall stays white at night — the owner: *"a wall
texture always white and showing some shadows of the board"* — a lit room
with a dark board on it. The frame's shadow is a mounted board's: low, soft
and long, with a contact edge, which is what says it is installed. An
inline session fades for half a second when it ends before the page comes
back.

## Consequences

- Lessons stored before this write the same words; they draw smaller and
  lighter on the next replay, since size and weight are the board's, not the
  lesson's.
- Wrap and camera tests were made independent of the scale where they had
  assumed one.

## Amendment (2026-09-25): the lines sit close, the page pads 36, a title breathes

The owner, on a Swift lesson on the blackboard: *"the spacing before titles
are fine, but the spacing between other lines are not, they should be less.
Also the starting should be more from the top. a lot of spaces on the top.
also start a bit less from the left. so top and left padding should be
36px."*

- **The page's margin is 36**, from 80. It is 36 CSS px at zoom 1 and
  scales with the writing on a smaller box, as everything on the page does.
- **The camera frames the page flush.** `showPage` used to fit the page
  inside the camera inset and then pad it by half that inset again, so the
  first word arrived after the inset *and* the margin. It now fits the page
  to the screen exactly, from the page's own top-left (or top-right for a
  right-to-left lesson): the margin is the whole of the padding.
- **`lineGap` is 4**, from 10. A line already carries its leading (1.3 em
  for the hand, 1.5 em for code), and 10 on top of it was the air the owner
  saw. `relativeGap` — `below` — is 12, from 24, for the same reason.
- **Code is 1.5 em with a 2-unit pad**, from 1.55 em and 6. One code line
  under another is now 44 world units apart (60 before); a line of writing
  under another, 41 (47 before).
- **A title asks for `TITLE_GAP` (8) before it** when it follows other
  writing, so the space before a heading stays where the owner found it
  fine. Nothing is added at the top of a column or page.

`layout.test.ts`, `camera.test.ts` and `executor.test.ts` pin the numbers;
`ink.test.ts` holds the code line height in TypeScript and CSS together.
