# ADR-0041: Chalk on any board, except in its own colour

Status: accepted · 2026-09-23

Supersedes the compatibility half of ADR-0034 ("a board is a marker board or
a chalk board, and that decides everything").

## Context

ADR-0034 gave the lesson a catalogue of surfaces and tied the writing
implement to each one: a whiteboard and Ivory took markers, the blackboard,
the green board and Smoked glass took chalk, and the colours came in two sets
with the tool's name in each id. The preference stored one colour per kind so
that moving between boards lost nothing.

The owner looked at it on 2026-09-23 and ruled that the tie was wrong:

> *"it doesn't make sense to have chalk for dark mode and marker for the
> white mode. A chalk can be used for different board colors and same with
> markers. The only thing that should not be pickable is the same
> chalk/marker color as the selected board background, like a black board the
> user should not be able to choose a black chalk or marker. That's it. They
> should just get disabled. The user can choose a chalked board but use a
> marker for it, and vice versa. That's fine as long as the colors of them are
> not the same."*

## Decision

### Three axes, chosen independently

A **surface** (the board), a **tool** (chalk or marker) and an **ink** (one
colour) are three separate choices. `BoardPreference` is
`{ surface, tool, ink }`. `auto` on any axis means "what the surface would
have": a whiteboard by day and a blackboard at night; a marker on a light
board and chalk on a dark one; black ink on a light board and white on a dark
one. That is what everybody has before they choose, and choosing is still the
paid act: `auto` is free on every axis, every pinned surface, both tools and
every colour but black and white are Standard, and Smoked glass stays
Professional.

### One palette, tuned per surface

`InkId` is a colour name — `black`, `white`, `red`, `blue`, `green`,
`yellow`, `pink` — and no longer carries a tool. The same "red" must be a deep
marker red on cream and a warm chalk red on slate, so each `[data-board]`
block in `tokens.css` declares its own seven `--ink-*` values and
`[data-ink]` only picks one. The board owns legibility; the name owns which.

### The one rule

An ink may be anything except the surface's own colour. Each surface names
that colour (`BoardSurface.colour`: the whiteboard and Ivory are white, the
blackboard and Smoked glass black, the green board green), `inkUsableOn()`
says it once, and it is enforced in two places because only one is visible:

- **The picker disables the dot** — a real disabled button, the same dot in
  the same place on every board, with *the board's colour* written under it.
  Not hidden, because a colour that vanishes when the board changes reads as
  a bug; not a link to Pricing, because it is not a limit.
- **`resolveInk()` refuses to paint it** and paints the surface's default
  instead, *without touching the stored choice*. A learner who chose white on
  the blackboard and visits the whiteboard is written to in black there and
  in white again on the next dark board. Nothing is silently discarded, which
  was the whole reason ADR-0034 kept two colours.

### The old shape is read, not rejected

A preference written before this decision — `{ surface, marker, chalk }` — is
accepted by the schema itself and becomes the colour that surface would have
used, with the tool left to the board. A stored blackboard with yellow chalk
is still a blackboard written in yellow. This runs wherever `BoardPreference`
is parsed: the device key, and the account's copy the API hands back.

## Consequences

- The tool is modelled, chosen, stored on the device and the account,
  previewed in Settings (every swatch is re-written in the tool in use) and
  stamped on `<html>` as `data-tool`. **The live board does not yet draw a
  chalk stroke differently from a marker stroke.** The ink shapes take their
  colour from `--color-ink` and nothing else, and an export is one rasterised
  picture whose rendering path was not verified against a new token in this
  change. Giving chalk its dust and marker its solid edge on the canvas is a
  board-package change and a follow-up, and it has a hook to hang from.
- `packages/contracts/test/board-backgrounds.test.ts` and
  `packages/app/test/board.test.tsx` hold the rule from both sides;
  `apps/web/e2e/ui-settings.spec.ts` checks the disabled dot on the rendered
  page in both themes.
- The Pricing card's Standard line now reads the number of colours from the
  catalogue as it reads the number of boards.
