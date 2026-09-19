# ADR-0007: Design system — "Pen" tokens in OKLCH from the approved palette; board is always paper

Status: superseded in part by ADR-0023 · accepted 2026-09-16

## Context
The user supplied palettes: navy #0C2C47, green #2D5652, yellow #E2A54D, aqua
#97D3CD, pink #EFEAE6, mint #E4F2EA; mn_teal #008EAA ramp; mn_red #A6192E and
mn_green #78BE21 ramps. The mockup uses a dark app chrome with a light paper
board and a serif display voice.

## Decision
- Brand: navy (ground/dark chrome, ink on paper), teal #008EAA (interactive
  accent), yellow (highlight/attention, ads), aqua/mint (success, presence),
  red (danger/leave), pink (paper tint).
- Tokens live in `packages/design/tokens.css` as CSS custom properties in
  OKLCH with semantic names (`--color-bg`, `--color-ink`, `--color-accent`,
  `--color-paper`, …) and light/dark themes; components never use raw hex.
- Type: display serif "Fraunces" (OFL) for headings, "Inter" for UI, "JetBrains
  Mono" for code, "Caveat" (OFL) as the board handwriting face.
- The board is always light paper with a dotted grid regardless of theme, like
  a real whiteboard shared over a call.
- Motion tokens: 120/200/320/550 ms with one ease; reduced-motion respected.

## Consequences
One source of truth for every surface, including Electron and export frames.

## Amended 2026-09-18 — the accent is a family, and the shell has its own surface

The owner's note was that the platform "looks very death like, and not properly
standing out", with a hint that the brand colour itself may change ("for
example that green one"). Two changes follow, and they are deliberately small.

- **The accent family is switchable.** `--color-accent`, `-strong`, `-pressed`,
  `-soft` and `--color-on-accent` are the only five tokens a brand owns.
  Teal stays the default, declared in `@theme`; `data-brand="green"` (the
  #78BE21 family) and `data-brand="forest"` (the #2D5652 family) re-declare
  those five for light and dark at the bottom of `tokens.css`. Switching the
  product's colour is one attribute on the document element. Every family is
  measured in `caption-contrast.test.ts` against the same pairs as the default,
  so a brand nobody can read cannot ship. The board keeps its own
  `--color-ink-accent` on teal: a session's sketch is rendered once into a
  file, and it must not change colour under a reader on another brand.
- **The shell has a surface of its own.** `--color-chrome` (the sidebar and the
  footer) and `--color-band` (a section's header row) are mixed in oklab from
  `--color-surface` with 4 % and 8 % of the accent. They are a step off the
  page rather than another border, and because the step carries a trace of the
  accent the frame warms to whichever brand is active instead of going grey —
  which is what made the product read as lifeless.
- `--shadow-thumb` / `--shadow-thumb-hover` give a session thumbnail a hairline
  and a short shadow. The sketch is paper in both themes, so on a light page
  it had no edge at all.


## Superseded 2026-09-19 — Material Design 3 is the system

ADR-0023 replaces the type scale, the shape scale, the shadows and the colour
role names decided here with Material Design 3's own, generated from the same
teal. What survives from this ADR: the board is always light paper with a
dotted grid whatever the theme, its ink is pinned to the brand teal, and the
motion tokens (120 / 200 / 320 / 550 ms with one ease, reduced-motion
respected). The switchable brand family survives too, re-expressed as M3's
`primary` / `secondary` roles rather than the five `--color-accent-*` tokens
named above, and measured now in `packages/design/test/design-system.test.ts`.
The display serif named here was never adopted; headings are set in the UI
face at its display optical size.
