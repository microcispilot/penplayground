# ADR-0054: The Pem palette

Status: accepted · 2026-09-25 · amended the same day (rose by night)

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
| brand | `#A9124A` | buttons, Sign in, selected rows and chips, brand-coloured text, the mark's delta, progress, the board's ink |
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

## Amendment (2026-09-25): rose by night

The owner, on the dark header: *"can this sign up for free text and border
be a bit lighter? it's not properly visible. we should use a shade or tint
or something."* The outlined button's label and border are `primary`, the
text role, which by night was the brand at 2.7:1. It is now the palette's
rose `#E1799D` — 6.6:1 on the dark `surface`, 4.3:1 on the highest grey,
the one step it misses, recorded — with plum `#470928` on it where it is
ever a fill (5.6:1). Fills, selections, the delta and the board's ink stay
the brand; the light theme is untouched.

## Amendment (2026-09-25): the brand is #A9124A

Shown the earlier pill (`#8A1A41`) beside the current one (`#B30D4D`), the
owner asked for a colour between them and chose the stop three quarters of
the way, blended in OKLCH: `#A9124A` (0.478 / 0.182 / 7.6°). Every place the
brand is painted follows it. White on it is 7.3:1; on the light `surface`
6.9:1; on the dark page 2.5:1, recorded as before.

## Amendment (2026-09-25, later): the brand is off the board

The one-ink ruling above landed in the export path (`resolveInk`) and not in
the live one (`inkVar`), so an `accent` line on the blackboard was still
drawn in `--color-ink-accent` — the brand, at 2.2:1 on that board — and the
owner saw it as red: *"why we have the red color on the board?"* and then
*"do not use this color on the board: --color-ink-accent, the brand #A9124A,
remove it."* Both paths now read one table, every emphasis is the chalk the
learner chose, and the board's token allowlist (`paper-tokens.test.ts`) no
longer admits `--color-ink-accent`, `-warn`, `-muted` or `-highlight`. The
tokens themselves stay declared in `tokens.css` for the brand families'
tuning; nothing on the board asks for them. `ink.test.ts` pins it.

## Amendment (2026-09-26): a selected row is the brand with white on it, again

"Rose by night" made the sidebar's current row, a chosen topic, a chosen
feedback kind and a survey answer rose after dark, and the owner asked why
the row was "not reddish, like the background of the login button". The
brand itself as ink on the dark tint is 2.2:1 and read "too darkish"; a
blush fill under it was a background change the owner had not asked for and
rejected; a lighter tint under a red ink cannot reach 4.5:1. The owner then
ruled: "revert it back to the way it was: the background is the primary and
the foreground is white." So the selected tinted state is M3's own pair,
the brand fill with white on it. The solid fill was "too colory; maybe the
brand color with a bit transparency", and 80 % still "too colory, I want it
more transparent". A translucent brand followed (a token of its own,
`selected`: the brand in oklch at 75 % by day and 50 % by night), and then
the owner asked for "the lighter background shade we have", running "all the
way to the left edge". A neutral grey step was "black and not reddish"; a rose
tint at 45 % followed; and the owner settled: "use the previous one with
foreground as the primary brand color". So the sidebar's current row and a
chosen topic sit on `surface-container-highest` with the brand as ink, icon
and label alike, flush with the sidebar's left edge (the nav has no left
inset; the rows carry the padding). The brand on that step is 5.4:1 by day
and 2.5:1 by night; the owner chose it knowing. A chosen option in a dialog
and a chosen feedback kind keep `selected` (rose at 45 %) with `on-surface`.
The `secondary-container` token itself stays the brand. The rows are square again: "rounded from the sides", then
"make it 4 px rounded", then "no corner radius", all within the hour, and the
last word stands, as it did on 2026-09-25. The rows are rounded
on the sides ("make the background rounded from the sides"), replacing the
square ruling of 2026-09-25. `primary` stays rose by night for prose, links
and outlines. The sidebar test pins the classes and the shape.
