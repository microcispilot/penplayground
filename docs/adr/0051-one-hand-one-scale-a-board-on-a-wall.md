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

### One weight

The face is heavy. Handwriting is eroded to a normal weight (0.021 of the
type size a side; headings 0.01, semi-bold rather than bold), and the HTML
text — code and prose — is asked the same weight with a hairline of paper
over each glyph's edge.

### A board on a wall

The player's surface colour surrounds the frame with room to breathe, in
the room and inline, so the board reads as an object hanging in a space
rather than a texture filling the viewport. The frame keeps its bevel and
its shadow, which is what says it is standing off the wall.

## Consequences

- Lessons stored before this write the same words; they draw smaller and
  lighter on the next replay, since size and weight are the board's, not the
  lesson's.
- Wrap and camera tests were made independent of the scale where they had
  assumed one.
