# ADR-0034: The board is a surface you choose

Status: accepted · 2026-09-22

Supersedes the board half of ADR-0007 ("the board is always paper").

## Context

ADR-0007 fixed the board as light paper with a dotted grid, in both themes and
under every brand family, and it gave a good reason: a session's sketch is
rendered once, server-side, into a file, and a reader on another theme must see
the same picture. A board that followed the app's theme would have meant a
thumbnail that disagreed with the page it was on.

That reason was about **rendered files**, and it was right about them. It was
never a reason for the board to be *one particular colour forever*, and reading
it that way is what left the product with a dotted white sheet that looks like
a design tool rather than like a lesson.

The owner asked for the real thing, over several passes:

> *"the users should be able to pick board styles from a list of boards but
> only paid users … we have black boards, smoked boards, green boards, whitish
> boards"*

> *"the board should have a real board like background not with dots … Black
> for dark mode, and white for white mode. But not a simple black, it should be
> like smoked black, and white should be not real white, a little creamish"*

> *"a chalk should not be usable on a marker board and vice versa so the
> choosing UI should properly filter or show disabled something that is not
> eligible. these should be for paid users."*

Three separate things are being asked for there, and they pull in different
directions unless the model is right:

1. a **default** that follows the theme — white by day, black at night;
2. a **catalogue** of surfaces a learner can pin, which must therefore *not*
   follow the theme, because a green board is green in a dark room;
3. a **writing implement** whose compatibility depends on the surface.

## Decision

### A board is a marker board or a chalk board, and that decides everything

`BoardKind` is `marker | chalk`. It is not decoration: it is the compatibility
rule the owner asked for, and it is enforced in `resolveInkId()` rather than
remembered by whoever writes the next picker.

### `auto` is the default and is not a board

`auto` means "whichever of the two default boards matches the page" —
`whiteboard` in light, `blackboard` in dark. It is the only surface a free
learner may select, because **choosing is the paid act**. A free learner is
never given a worse board, only one they did not pick.

Every other id is a *pinned* surface and ignores the theme. That is the whole
difference between the default and a choice, and it is why `auto` carries
`kind: null` — it has no kind of its own until the theme resolves it.

### The preference keeps one colour per kind, not one colour

`BoardPreference` is `{ surface, marker, chalk }`. A single "ink colour" would
have to be silently discarded every time the learner moved between a whiteboard
and a blackboard, which is the kind of quiet data loss nobody reports and
everybody notices. Keeping both means a learner who likes yellow chalk and a
black marker chooses each once.

### Colours live in the design system, never in contracts

Every value is a `[data-board]` or `[data-ink]` block in `tokens.css`, the same
mechanism as `[data-brand]`. Contracts owns the set, the kinds and who may use
what; the design system owns what it looks like. A swatch is drawn by putting
the attribute on a preview element, never by reading a hex out of a TypeScript
file.

The board blocks are appended **after** every brand family on purpose. Both are
single attribute selectors, so they have identical specificity and source order
decides. A family re-tunes `--color-ink-accent`; a dark board must override
that, because teal at 3.59:1 on paper is unreadable chalk on slate.

### There is no grid

The dots are gone. A real board does not have them; what it has is a surface,
and that is now grain (`feTurbulence` at `--board-grain`) plus the uneven wipe
of a board that has been cleaned a thousand times. Both are fixed to the
element rather than to the camera — a texture that zoomed with the canvas would
swim under the ink.

`--color-paper-grid` survives, because it was never only the dots: the markdown
block still rules `<hr>`, `<pre>` and table cells with it.

### The frame is chrome, not board

The learner sees a framed board with a tray. The frame lives *outside* the
board element, in the app's own chrome, so `editor.toImage` never sees it.
Exports, thumbnails and MP4s come out as the surface alone. The owner chose
this directly: a thumbnail grid of framed pictures is a grid of picture frames.

### No italic anywhere on the board

The board is written in a hand face that already slopes; slanting it again is a
smear rather than an emphasis. `_like this_` takes the accent ink instead —
which is what a teacher reaching for a second colour actually does — and Shiki's
italic bit is forced off at the highlighter and again at the renderer, so a
future highlighter that starts reporting italic cannot slip it back in.

## What survives from ADR-0007

The part that was actually load-bearing, and it is unchanged:

- **A rendered file is one picture.** Exports are still rasterised once, with
  the surface baked in. They are not re-rendered per viewer.
- **No board source may reference a page token.** `paper-tokens.test.ts` still
  fails the build if anything under `packages/board/src` reaches for
  `--color-surface`, `--shadow-card` or any other theme-flipping token. This
  matters *more* now, not less: the board is a surface of its own, and a page
  token borrowed into it would follow the app's theme instead of the board —
  which is exactly how a blackboard ends up with a white note card on it.

## Consequences

A dark board breaks assumptions the light one never did, and each is handled
rather than discovered:

| What | Why it breaks | Token |
|---|---|---|
| Highlighter blend | `multiply` can only darken; on a dark board it paints nothing | `--board-marker-blend` |
| Code theme | Shiki emits literal hex, so the board cannot re-tint it | `--board-code-theme` |
| The dim veil | 55 % navy over slate is just more slate | `--board-dim` |
| The note card | a near-white card on a blackboard is a hole in the board | `--board-note` |

`--board-code-theme` is a number rather than a colour because Shiki picks a
theme by name and CSS has no way to hand it one.

An export now depends on who rendered it: a learner's own download is on their
board. A replay shared with someone else shows the viewer their own board,
because the live board is a preference and not a property of the lesson. That
is the trade the owner chose when asked directly, over the alternative of
pinning every export to paper.
