# ADR-0054: The Pem palette

Status: accepted · 2026-09-25

Supersedes ADR-0052 (wine is the brand) and its amendments.

## Context

The owner compared redder candidates against the wine (`#8A1A41`), then
brought a palette extracted from the Pem artwork, and asked for it "a bit
youtubish, very little". Of three nudges toward red at the same darkness
they chose the smallest, and ruled:

> *"remove the mint, we can use white instead of that, or very close to
> white. this can be use primary on all main places B30D4D like buttons the
> tab items background, text, etc. and the logo alpha"*

## Decision

| name | hex | where |
| --- | --- | --- |
| brand | `#B30D4D` | buttons, Sign in, selected rows and chips, brand-coloured text, the mark's delta, progress, the board's ink |
| wine | `#7F0D3F` | `tertiary` |
| plum | `#470928` | text on blush |
| crimson | `#C42163` | `highlight`, the live voice on the board |
| rose | `#E1799D` | `glow` (an edge glow), `inverse-primary` by day |
| pink | `#E6AEBE` | declared |
| blush | `#EBD7DA` | the check-in card's frame, `tertiary-container`, the green board's ink |
| periwinkle | `#94ABD7` | declared |

The base `#B01656` was given exactly; the other eight were sampled from the
owner's screenshot and the brand is that base moved four degrees toward
red with a touch more saturation (OKLCH 0.495 / 0.193 / 7.9°). Mint is
gone: where a headline wanted it on a dark ground, it is white.

One set of values for both themes, as ADR-0052's amendment already ruled:
`primary`, `primary-fixed`, `secondary-container`, `mark-accent`, `glow` and
`highlight` do not change with the page. The mark's delta is the brand.

## Measured

- White on the brand: 6.8:1. The brand on the light `surface`: 6.5:1; on
  the highest light grey: 5.3:1; on paper: 6.5:1.
- The brand on the dark `surface`: 2.7:1; on the highest dark grey: 1.8:1;
  on the blackboard: 2.3:1; on smoked glass: 2.5:1. Under WCAG's 4.5 for
  text and 3 for graphics, by the owner's ruling; pinned in the tests as a
  recorded cost. Blush on the green board: 5.5:1.
- The brand and the error role (`#BB162A` by day) are 0.053 apart in OKLab:
  two reds one hue apart. An error still says what went wrong in words.

## Consequences

- `ring-brand-blush` is the only palette token used by name outside the
  tokens; the others are declared for the places that ask for a member.
- The board's sketches follow the ink on their next paint; nothing on disk
  is re-rendered.
- `brand-generator.test.ts`, `design-system.test.ts`, `brand-mark.test.ts`,
  `ui-brand.spec.ts` and `ui-logo.spec.ts` pin the values above.
