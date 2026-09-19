# ADR-0023: Material Design 3 is the design system

Status: accepted · 2026-09-19 · supersedes the scale, shape and colour
decisions in ADR-0007 (the board-is-always-paper decision there still stands)

## Context

The owner's note, close to verbatim: *"I hate large fonts and texts. I want a
real proper design system to be used. you should think, if it was Google to
build this system how they would've designed the UI and styles? you should do
the same. we can use proper design system like material design latest."* —
with a link to the M3 Expressive announcement and the Expressive component
sheet: pill-shaped buttons across a size range, connected button groups, a
segmented selector, icon buttons grouped in a rounded container, a navigation
drawer whose items are filled pill rows.

What we had was a house scale invented one screen at a time. `tokens.css`
carried eight t-shirt sizes and six radii that matched nothing; components
reached past them anyway, with 110 `text-[13px]`-style literals, 73
`rounded-[…]` literals and six different responsive `clamp()` headings. The
hero measured 56 px.

## Decision

**M3 is the system, not an influence.** Three scales replace the house ones,
and every number in them was read out of Google's own packages rather than
recalled:

- **Type** — the fifteen M3 typescale roles with their line-heights, tracking
  and weights, from `@material/web@2.5.0`
  `tokens/versions/v0_192/_md-sys-typescale.scss`, plus the Expressive
  *emphasized* set (same metrics, one `--md-ref-typeface-weight-*` step
  heavier). The t-shirt namespace is cleared (`--text-*: initial`), so a size
  can only be named by role.
- **Shape** — `none 0 · xs 4 · sm 8 · md 12 · lg 16 · lg-increased 20 ·
  xl 28 · xl-increased 32 · xxl 48`, from `_md-sys-shape.scss` plus the
  Expressive `-increased` and `xxl` additions. `--radius-*` is cleared the
  same way.
- **Elevation and state** — M3's two-part elevation shadow evaluated at each
  of the five levels from `@material/web`'s `elevation-styles.css`, and M3's
  state-layer opacities (hover 8 %, focus 12 %, pressed 12 %, dragged 16 %)
  from `_md-sys-state.scss`, applied through one `state-layer` utility.

**Colour is M3's role set, generated from our own teal.** The palette comes
from `@material/material-color-utilities@0.4.0` — `SchemeTonalSpot` seeded
with the brand teal #008EAA, read through `MaterialDynamicColors`. Surfaces
are expressed as M3 expresses them: `surface`, the five `surface-container-*`
steps, `on-surface`, `on-surface-variant`, `outline`, `outline-variant`, and
the `primary` / `on-primary` / `primary-container` / `on-primary-container`
family, with `secondary-container` carrying every selected state.

Neither package is a dependency of this repo. They generated the values once;
the values are the artefact, and `packages/design/test/design-system.test.ts`
re-measures them.

Two owner constraints shape the colour, and both are honoured *inside* M3's
machinery rather than around it:

- **Matte.** The neutral and neutral-variant tonal palettes are generated at
  chroma 0 instead of M3's default 6 and 8, so surfaces separate by value
  alone — no tint, no wash, no sheen. M3's own teal-tinted neutrals would have
  put a cool cast on every dark panel, which is the look this replaces. The
  `--color-wash-*` tokens are gone.
- **Teal.** Every board sketch is drawn in teal ink, so the primary palette is
  seeded from #008EAA and `--color-ink-accent` stays pinned to that exact
  tone. A different hue would make the session page read as two brands.

**Smaller, deliberately.** Nothing on a page a learner reads every day reaches
a `display` role. The hero is `headline-large` (32 px, from 56); page titles
are `headline-small` (24); section headings are `title-large` (22); body copy
is `body-medium` (14) and metadata `body-small` (12) or `label-small` (11).

**Components follow the Expressive sheet.** Buttons are true pills at every
size (32 / 40 / 56 px). `ButtonGroup` connects a run of them — outer ends
`corner-full`, joins `corner-small`. `SegmentedButtons` is M3's outlined
segmented button and is what Pricing's billing period now is.
`IconButtonGroup` is the rounded toolbar container the room's controls sit in.
The sidebar's rows and the header's links are M3 navigation items: a
`secondary-container` pill is the active indicator, which is why the tinted
bar that used to run down the left edge of the active row is gone.

**One extension, named as one.** `--color-on-surface-dim` is not an M3 role.
M3 gives text two levels and makes a third by dropping a size; this product
has a real third rank (a timestamp under a title that is already under a
heading), and collapsing it onto `on-surface-variant` made three ranks read as
two. It is neutral tone 40 (light) / 65 (dark) from the same generated
palette, and it clears 4.5:1 on every surface in the ladder.

## Consequences

- A stale utility is now *silent*: Tailwind emits no rule at all for
  `bg-fg-2` once that token is gone. `design-system.test.ts` therefore walks
  `packages/app/src` and `packages/design/src` and fails on any colour, size
  or corner utility the stylesheet cannot answer, and on any raw `text-[…]`.
  It also pins the two scales to Google's numbers, checks that the dark scheme's
  two hand-kept copies agree, and measures every pair that carries text —
  under all three brand families, in both themes, on every surface in the
  ladder.
- The three brand families survive; each is regenerated through the same M3
  variant. Surfaces do not move between them, because chroma-0 neutrals are
  the same under every brand — which is the point of a matte page.
- One fidelity caveat, left open for the owner: M3's tracking values are drawn
  for Roboto, and this stack resolves to SF Pro on macOS and Segoe UI on
  Windows. The values are M3's, kept as M3 wrote them; retuning them is one
  line in `tokens.css`.
