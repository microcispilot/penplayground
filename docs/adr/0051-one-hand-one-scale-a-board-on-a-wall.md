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

`TYPE` is 36 / 24 / 20 / 18 / 18 (title, writing, label, code, prose): the
title 1.5× the writing, the writing 1.2× a label, code and prose a step
under. A board reads as one hand at one distance, not a headline over
footnotes. The camera's legibility floor is 14 CSS pixels for the writing,
which at this scale still lets a 1200-wide line fit a phone.

### One hand

Code and prose are set in the hand too. The face lacks a few glyphs —
`<`, `>`, `[`, `]`, `}` — and for those alone the stack's next face steps
in, per glyph. That is what "except what the font cannot do" means. Code
blocks and prose are sized with the hand's own advance, and the language
badge is gone: the expert said what the lesson is in.

### One weight, and intact

The face is heavy. Handwriting is eroded towards a normal weight — 0.012 of
the type size a side, headings 0.005 so they stay semi-bold — and no
further: a first round at nearly twice that broke the chalk's thin strokes
into specks, and a normal weight is worth having only if the glyphs stay
whole. Code and prose keep the face's own weight; a paper hairline over
their edges read as damage.

### A page is a frame

The camera keeps the whole current page on screen at whatever zoom the
screen allows — below the legibility floor if it must — and follows only
what leaves the page. That is how a video shows its whole frame in a small
box and a big one. Cropping the page to keep the writing readable was what
hid the bottom of a board in the inline player; a reader who wants it larger
makes the box larger, as with a video.

### A board on a wall

Plaster: a cream with a fine grain (a turbulence filter in a data URI, so it
ships with the stylesheet), darker towards the edges the way a lit wall is,
in the room and inline, so the framed board reads as an object hanging in a
room. Dark theme gets a darker warm plaster. The frame keeps its bevel and
its shadow, which is what says it is standing off the wall. An inline
session fades for half a second when it ends before the page comes back.

## Consequences

- Lessons stored before this write the same words; they draw smaller and
  lighter on the next replay, since size and weight are the board's, not the
  lesson's.
- Wrap and camera tests were made independent of the scale where they had
  assumed one.
