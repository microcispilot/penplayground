# ADR-0052: Wine is the brand

Status: accepted · 2026-09-25

Supersedes the colour decision in ADR-0034's brand review (the YouTube-adjacent
red, #E62117). Extends ADR-0041 (chalk and marker) for the board's accent ink.

## Context

The owner handed over a palette with a role beside each member:

| member      | hex       | the owner's role      |
| ----------- | --------- | --------------------- |
| wine        | `#68113C` | pills, icon           |
| berry       | `#95214E` | mid gradient          |
| brand       | `#8A1A41` | main: buttons         |
| brand-light | `#AE2A58` | glow, highlights      |
| glow        | `#CB688C` | edge glow             |
| blush       | `#DFBDC7` | card frame            |
| mint        | `#D0F5EB` | headlines             |

Measured before anything was written (`packages/design/test`, and the numbers
in `tokens.css`): the deep members read on the light surfaces — brand is
8.7:1 on `surface`, wine 12:1 — and vanish on the dark ones, where brand is
2.0:1 on `surface` and wine 1.7:1 on a blackboard. The pale members do the
opposite. One hex cannot be the brand in both themes, and the old red's rule
("the same hex in both") does not survive this palette.

## Decision

### The roles, by day

`primary` and `primary-fixed` are the brand, `#8A1A41`: Sign in, Start, the
lesson's progress, a link, the board's accent ink (`oklch(0.422 0.148 6)`,
8.5:1 on paper). The mark's delta is the wine, `#68113C` (`--color-mark-accent`).
`inverse-primary` is the glow. `secondary` stays neutral — it is a headline,
and the owner's colours are for the confident places, not every heading.
`tertiary` takes the mint: a green container with deep-green text, for the
few chips that are not the brand. `--color-glow` is the focus ring, and
`--color-highlight` (brand-light) is the live-voice colour on the board
(`--color-speaking`). Each member is also declared by name
(`--color-brand-wine` … `--color-brand-mint`) for the places that ask for a
member rather than a role; the check-in card's frame is blush, as the owner
labelled it.

### The roles, by night

The brand fill (`primary-fixed`) is the glow, `#CB688C` — 5.2:1 on `surface`,
deep-wine text `#2B0716` at 5.2:1 on it. `primary`, which carries text, is a
lightened glow `#D98BAA` (4.8:1 on the highest grey, where the glow is 3.6).
The delta is the glow. The dark boards draw their accent in the lightened glow
(6.2:1 on blackboard, 6.5:1 on smoked) and, on the green board where that is
2.9:1, a lighter one still (`#E8A0BB`, 3.7:1). The containers under selected
rows remain platform greys, as ADR-0034 decided and the generator test
enforces.

### What did not move

Error stays the owner's `#ED424A` ladder; the brand still sits at red's door
(0.110 apart in OKLab by day, four times what the old red managed but inside
the 0.15 where two colours become one), so colour alone still never carries
an error. `--color-ink-warn` stays amber for the same reason.

### The mark

The generator recognises the artwork's `#E62117` and paints `mark-accent` in
its place; the favicon carries a `.delta-fill` rule per colour scheme beside
the ink's. The owner's SVGs are untouched and still hash-pinned. The rasters
sit on a light ground and are wine.

### Left for the owner

Berry ("mid gradient") and mint ("headlines") are declared and unused: the
product has no gradient surface, and a mint headline needs a dark or wine
ground the product does not yet paint. They wait for the surface rather than
being put somewhere to be seen.

## Consequences

- `primary-fixed` is per theme. `apps/web/e2e/ui-brand.spec.ts` and
  `ui-logo.spec.ts` assert the pair, and `brand-generator.test.ts` asserts
  the reason (the wine under 3:1 on the dark surface).
- Sketches rendered before this are SVG filled with `var(--color-ink-accent)`
  and follow the wine on the next paint; nothing on disk is re-rendered.
- The `[data-brand]` candidate families are unchanged: they record the
  review that chose the red, and the tests that measure them still pass.
