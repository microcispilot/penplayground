# ADR-0007: Design system — "Pen" tokens in OKLCH from the approved palette; board is always paper

Status: accepted · 2026-09-16

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
