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

**Colour is M3's role set.** The palette comes from
`@material/material-color-utilities@0.4.0` — `SchemeTonalSpot` read through
`MaterialDynamicColors`. It was seeded with the brand teal #008EAA when this
ADR was written; the brand is now the red #E62117 and the seeded machinery
describes everything except the brand roles themselves (see the second
addendum). Surfaces
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
- **One hue for the app and the board.** Every board sketch is drawn in
  `--color-ink-accent`, and a page in one hue around sketches in another reads
  as two products. So the ink is pinned to the brand's own tone, whatever the
  brand is: #008EAA while teal was it, #E62117 now.

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

## Addendum — the generator, and what a red brand costs

*Added while answering "I want a real better branding colour, something like
youtubish or similar." Nothing in this addendum decided anything; the decision
is the one after it.*

The values above were produced once and pasted, which made "show me the
platform in another colour" an afternoon of arithmetic. It is now a command:
`packages/design/scripts/brand.ts` runs a seed through the same tonal-spot
machinery with the same chroma-0 neutrals, emits the CSS, and prints the
contrast table. It re-derives every colour in `tokens.css` from its seed —
`test/brand-generator.test.ts` asserts that against the hand-written original,
which is the only reason to believe it. `@material/material-color-utilities`
is still not a dependency; the script fetches it into `.pen-data/` and repairs
the extensionless ESM imports that 0.4.0 shipped with.

Four candidate families are in `tokens.css` under `data-brand`: `youtube`
(#FF0000), `vermilion` (#E62117), `coral` (#FF4438) — all tonal spot — and
`ember` (#E62117 through vibrant, with the error roles moved). Unlike green
and forest they re-tune the board as well as the chrome, because a red app
around teal sketches reads as two products.

Three things the generator made visible, all measured in
`test/design-system.test.ts`:

- **Tonal spot caps the primary palette at chroma 36.** Teal's own chroma is
  43.5 and survives it; a saturated red's is 90–113 and does not. #FF0000,
  #E62117 and #FF4438 all arrive as the same dusty brick (#904b40 / #904a41 /
  #904a42). Through this variant they are not three candidates.
- **In dark, a red brand *is* the error role.** All three land on #ffb4a8 and
  M3's dark error is #ffb4ab — ΔE 0.004 in OKLab, against teal's 0.170. No
  seed fixes this: M3 puts `primary` and `error` at the same tone of two
  palettes, and at tone 80 two red palettes are one colour.
- **The board has its own red.** `--color-ink-warn` is the ink an expert
  writes a *mistake* in (`session-engine/src/prompts.ts`), at OKLCH hue 20.4 —
  nine degrees from a brand red. Every red family moves it to amber at the
  lightness that keeps its 6.97:1 against paper.

`ember` is what it takes to answer the second point: the vibrant variant so
the seed's chroma reaches the light scheme (#c00003), and the error roles
re-seeded off red to magenta — the only family in the file that moves them. It
buys ΔE 0.043 in dark; teal has 0.170.

Two costs this addendum does not solve, and the owner should see them named:
`RoomChrome.tsx` draws "End" as `bg-error`, and `ListControls.tsx` draws a
*liked* session as `bg-error-container` — under a red brand the exit button and
the happy path both wear the brand. And session thumbnails are rendered once
into files, so every sketch already in a learner's library stays teal until it
is re-rendered.

## Second addendum — the decision: #E62117, fixed

The owner looked at all four and answered in two parts. **The red was right
and the palette was not.** Named specifically: the brown-orange pill under a
selected nav row — `secondary-container`, #5d3f3b and #653d28, which is what
M3's "calmer companion" to a red seed turns out to be — was rejected. The
Sign in pill at #930002 was kept. And: *"the same red youtubish colour like
what is used in sign in to be used both for dark and light."*

That last clause is what shapes the answer, because M3 cannot honour it
through a seed. Tonal spot flattens a red; vibrant rescues the light scheme
and leaves dark on tone 80. So the brand is declared rather than generated,
and it is declared as **`primary-fixed`** — M3's own role for a colour that
must not change between themes:

- `--color-primary-fixed: #e62117` / `--color-on-primary-fixed: #ffffff`, in
  `@theme` and nowhere else. The dark scheme never redeclares it, which is
  what makes it fixed rather than merely named so. It fills the mark, Sign in,
  Start, the ask-send button, every `Button variant="primary"`, a liked
  session, and it is the board's ink.
- `--color-primary` stays toned per theme (#c00003 / #ff7a6e) because it
  carries *text*, and no colour at all clears 4.5:1 against both #ffffff and
  #353535. That is arithmetic, not a shortage of imagination, and
  `brand-generator.test.ts` proves it with black and white as witnesses so
  nobody goes looking for the hex that would have worked.
- **Every container fill is a platform grey, and selected is named in the
  brand.** This took three passes and each one is worth keeping, because the
  wrong answers were wrong in different directions.

  M3's own answer for a red seed is a brown-orange `secondary-container`,
  which the owner rejected on sight and rightly: a page of those turns
  brown-rose and the red stops reading as red. Neutralising the fill *and*
  the label fixed the brown and lost the brand — *"Why do I see less red?
  Only the sign in button shows red. Why not the background of the selected
  tab item?"* A saturated red fill put it back and read as loud: a solid
  block on the one row a person keeps returning to.

  The resolution is that the pill and the label are two decisions, and only
  one of them has to be red — *"maybe instead of the background of selected
  item to be red, you just make the previous background but make the text
  red instead."* So the fill is `surface-container-highest`, the grey behind
  every other raised thing, and the label and icon are `primary`: 5.00:1 in
  light, 4.83:1 in dark. It is `primary` and not `primary-fixed`, and the
  numbers are why — `#E62117` on those greys is 3.53:1 and 2.68:1. That is
  the clearest illustration in the system of what the two halves are for.

  `Progress`'s track moved to an explicit `surface-container-highest` while
  `secondary-container` was briefly red, and stayed there: a track should
  name the neutral it wants rather than borrow a role that means selected.
- **The error role is the owner's #ED424A**, and this is the one place the
  measurement lost. Error was first moved to a magenta at hue 341, because a
  rose error is ΔE 0.095 from this red — inside the 0.15 that
  `design-system.test.ts` calls "shades of one another" — and the magenta
  cleared it at 0.175 light and 0.157 dark. The owner then chose #ED424A,
  which is a red six degrees of hue from the brand: 0.025 in light, 0.130 in
  dark. That is their call and it is implemented, with the consequence stated
  rather than hidden: in light, a failed request and the Start button are very
  nearly the same red, so an error has to say what is wrong in words and the
  colour can only agree with them. The number is recorded in `RECORDED` and
  the separation gate now names the default as its one exemption, so the hole
  is visible and a drift still fails. Families that used to inherit M3's red
  error declare their own, so the four candidates still record their collision
  honestly.

  It is laddered rather than pinned, unlike the brand, for a reason that is
  not stylistic: #ED424A carries white at 3.83:1 and reads on a light page at
  3.64:1, falling to 2.96:1 on `surface-container-highest`. `text-error` is
  body copy, so the role is the readable tone of that red — #bb162a in light,
  #ffb3b0 in dark.
- **Red no longer means "wrong".** "End" is an M3 filled-tonal button
  (`Button variant="neutral"`), a liked session is the brand, and the ad lane
  in Insights is `tertiary`. `CLAUDE.md`'s one-line "no red for ordinary
  states" is now a paragraph about which of the two reds a change is reaching
  for.

**Teal is a family, not a deletion.** `data-brand="teal"` is the platform
exactly as it was, and the generator still re-derives every one of its roles
from #008EAA — which is the proof the values moved across intact rather than
being retyped. Two things still need it: a board rendered before today is a
file on disk and keeps its teal ink, and a brand decision that cannot be
reversed in one attribute is a migration rather than a decision.

`apps/web/e2e/ui-brand.spec.ts` keeps producing the six-family review on six
screens in both themes, and now also reads the rendered Sign in button's
computed background in each theme and fails if it is not `rgb(230, 33, 23)`.

### Two smaller corrections from the same review

**A focus ring is not a validation error.** The ask bar drew
`0 0 0 2px var(--color-primary)` on `focus-within`, and the field is focused
the moment Home opens — so the first thing a visitor saw was their search box
outlined in a heavy dark red for no reason at all (*"wtf, why you have the
border of this input as red?"*). Focus now lifts the bar to elevation 2 and
draws a 1 px hairline in `outline`, which is neutral and clears WCAG 1.4.11's
3:1 on that surface. The brand stays where it means something: the caret, and
the Start button.

**`--text-label-tiny`, the file's second extension.** M3's smallest label is
`label-small` at 11 px, which is right for a label somebody reads and too big
for a *tag beside* one: "Professional" at 11 px is wider than the sidebar row
it annotates and truncated the row's own name. 10 px with wider tracking, and
only ever for a word that repeats something the row already says. Named as an
extension for the same reason `--color-on-surface-dim` is.

### The page is the brighter surface, and the furniture is not

The owner, looking at the catalogue: *"make the entire background white, no
line separator as well. only the bottom bar, top nav bar and left side bar
should be that other color."*

So the arrangement inverts M3's. The page is `surface-container-lowest` —
`#ffffff` in light, `#0e0e0e` in dark — and the three pieces of furniture
(header, sidebar, footer) are `surface-container-low`. M3 puts the page at
tone 98 and lifts everything above it; this puts the content at the top of
the ladder and the chrome below it.

The reasoning survives the inversion, and arguably reads better for this
product: the furniture and the content have to be two surfaces, and making
the content the brighter one means a thumbnail is the brightest thing on the
screen, which is what a catalogue is for.

**Every separator came out with it.** `border-b` under the header, `border-r`
beside the sidebar, `border-t` above the catalogue band and above the footer
— each of those existed to mark an edge that two surfaces now mark by
themselves, and a rule drawn along a colour change is the same edge stated
twice. The header also stopped being `bg-surface/80` with a backdrop blur: a
translucent header over a white page is a smear, and the line under it was
there to make up for being one.

A room and a replay keep `--color-surface`. They are not pages — they are a
single stage — and nothing in them is furniture around content.

*One thing this change surfaced rather than caused.* `ui-a11y` began failing
on Home's topic placeholder at 2.9:1, `#909090` on `#f4f4f4` — neither of
which is a colour in this system. axe measures *rendered* colour, and it was
catching the command bar mid-`animate-rise`, against a blend. Settled, the
same element computes `rgb(94,94,94)` on `rgb(232,232,232)`: 5.4:1. The scan
now waits for `document.getAnimations()` to stop before it measures, which
is what a person reads; gating on a frame in the middle of a fade would fail
every fade there is and say nothing about legibility. The earlier
intermittent reports of this same violation, recorded twice in `tasks/todo.md`
as "did not reproduce", were the same thing on a slower frame.

### Captions are film subtitles

They used to reveal themselves letter by letter, paced to the sentence's
audio. It looked like a machine typing rather than a person speaking, and the
owner said so: *"CC should be like in movies, one sentence at a time shown
synced."*

The reason goes past taste. A caption exists for somebody who cannot rely on
the audio, and a line that is still arriving is a line they cannot read at
their own speed — the one reader it is *for* is the one reader a typewriter
fails. So the caption holds one whole sentence, appears when that sentence
does, and is replaced by the next: the sync is the room's already, because
the caption *is* the line the room is speaking.

It is also measured now — `max-w-[46ch]`, centred — because a sentence
running the full width of a 1440 board is a line nobody reads in one
movement. That is roughly what broadcast subtitling allows.
