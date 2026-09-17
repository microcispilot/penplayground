# @pen/board

The paper. A tldraw 5 canvas with the UI hidden, the camera driven by the
expert's hand, and five custom shapes that make model-emitted `board` cues
look like a human writing: handwriting (`ink-text`), freehand strokes
(`ink-stroke`), typewriter code (`code-block`), small markdown (`md-block`)
and the pinned "You asked" card (`note-card`). ADR-0005 is the decision
record; ADR-0002 explains why the board only ever *follows* the audio clock.

Nothing outside this package imports tldraw.

## Public API

```tsx
import { Board, useBoardController } from '@pen/board';

function Room() {
  const board = useBoardController(reportToSentry);
  // conductor.board = board.port  (a stable BoardPort, safe to hold for the session)
  return (
    <Board ref={board.ref} licenseKey={key} onWarning={reportToSentry}>
      <ViewingChip name="Ada" />   {/* overlays render above the paper */}
    </Board>
  );
}
```

### `<Board>` props

| prop          | type                                | notes |
|---------------|-------------------------------------|-------|
| `licenseKey`  | `string?`                           | passed to tldraw; localhost needs none |
| `interactive` | `boolean` (default `false`)         | `false` = viewer cannot pan/zoom or touch shapes (camera locked, canvas takes no pointer input). Reserved for pinch-zoom later. |
| `fontUrl`     | `string?`                           | Caveat WOFF for opentype.js; defaults to the bundled `@fontsource/caveat` file |
| `onReady`     | `(controller) => void`              | fires once tldraw mounts |
| `onWarning`   | `(warning: BoardWarning) => void`   | non-fatal problems: unknown refs, sketch parse issues, font fallback. Wire to Sentry. |
| `className`, `children`, `ref` | | children render in an overlay above the paper |

### `BoardController` (what `ref` / `useBoardController().current` gives you)

Implements `BoardPort` from `@pen/conductor` exactly —
`execute(op, { paceMs })`, `pinNote(note, id)`, `setDimmed(bool)`, `clear()` —
plus `editor` (tldraw), `executor` (`BoardExecutor`), `dimmed`, and
`exportPng(opts?)` for thumbnails.

`useBoardController()` returns `{ ref, current, port, ready }`. `port` is a
stable `BoardPort` that forwards to the mounted board and no-ops (with a
warning) before mount, so the conductor can be constructed before React has
rendered the room.

### `BoardExecutor`

The `BoardPort` implementation, independent of React and tldraw:

```ts
new BoardExecutor({
  editor,            // EditorLike — adaptEditor(tldrawEditor) in the app, FakeEditor in tests
  ticker?,           // requestAnimationFrame by default; ManualTicker in tests
  layout?,           // Layout engine (page/column/cursor state)
  font?,             // GlyphSource; defaults to the module font registry (+ fallback after fontTimeoutMs)
  highlighter?,      // CodeHighlighter; Shiki by default
  camera?,           // CameraDirector; null disables
  measureMarkdown?,  // DOM-backed md-block height; estimate otherwise
  onWarning?, onDimmed?,
});
```

`execute()` is synchronous and never throws. Preparation (font, highlighter)
is async but serialised, so layout happens in cue order. Each returned
`BoardExecution` has `done`, `pause()`, `resume()`, `finish()`, `cancel()`;
control calls made before the shapes exist are remembered and honoured.

## Ops → shapes

| op          | shapes                                                | pacing unit |
|-------------|-------------------------------------------------------|-------------|
| `title`     | `ink-text` (58 px, accent underline drawn last)        | chars (+3 for the underline) at 11 cps |
| `write`     | `ink-text` (36 px)                                     | chars at 11 cps |
| `code`      | `ink-stroke` rounded frame, then `code-block`          | pen travel, then chars at 40 cps |
| `markdown`  | `md-block`                                             | chars at 40 cps |
| `sketch`    | per node: `ink-stroke` box/ellipse + `ink-text` label; per arrow: `ink-stroke` (+ label) | sequential, pen travel + chars |
| `highlight` | `ink-stroke` ring (or underline for wide refs), accent | pen travel |
| `arrow`     | `ink-stroke` shaft + open head, optional label         | pen travel + chars |
| `erase`     | opacity fade then delete; `all` restarts the page      | 360 ms |
| `newpage`   | page area moves down 1100; camera frames it            | 550 ms |

Pacing (`src/pacing.ts`): natural time comes from `TIMING.handwritingCps` /
`TIMING.typewriterCps` / pen speed; a longer sentence stretches the op to
`paceMs`; a shorter one never speeds it up; stretching is capped at 3× so a
three-character label cannot crawl through a twenty-second sentence.

Refs: every op id is a ref. Sketch nodes are also registered as `<opId>.<node>`
and bare `<node>`, so `highlight ref:"s"` works after the Query/Key/Value
sketch. Unknown refs warn and resolve; they never stall the lesson.

## Why a custom `ink-stroke` instead of tldraw's `draw` shape

tldraw's native `draw` shape (with `b64Vecs.encodePoints` and
`isComplete:false` updates) would animate, but:

- its colours are tldraw's palette enum, not our ink tokens (`--color-ink*`),
  so accent/warn/muted would need a theme override for every emphasis;
- its perfect-freehand options (size from `s/m/l/xl`, thinning, taper) are
  fixed by `DrawShapeUtil`; the ADR-0005 look (size 3.2, thinning 0.55,
  smoothing 0.6, streamline 0.5, simulated pressure) is not reachable;
- partial reveal by arc length would mean re-encoding the delta-compressed
  segment each frame anyway.

`ink-stroke` stores the full point list once and renders
`getStroke(visiblePrefix)` per frame from a single `progress` prop. That keeps
the store diff per frame to one number, matches the design tokens, exports to
SVG cleanly (`toSvg`) and is trivially deterministic across clients.

## How handwriting is revealed

`ink-text` lays text out with opentype.js glyph outlines (kerned, wrapped at
a max width, ±1 px baseline / ±1.5° rotation jitter seeded by the shape id).
Reveal is glyph by glyph; inside the active glyph a clip rectangle sweeps
left→right across its advance so ink appears where a nib would lay it, with a
small nib dot at the tip. Symbols Caveat lacks (√ → ← ≤ ≥ ≠ ∑ ∞ π λ ∈ …) are
synthesised as pen strokes and revealed by `stroke-dashoffset`; anything else
falls back to CSS text in `--font-hand` under the same clip. If the font
never loads, a metrics-only `FallbackFont` keeps layout and reveal working.

Path data is serialised from opentype's `path.commands` by `src/svg-path.ts`,
never via `Path.toPathData()`: opentype.js 2.0.0's number formatter emits
`"NaN"` for finite values whose fractional part stringifies in exponent form
(e.g. `18.000000000000004`), which Chromium reports as
`<path> attribute d: Expected number`. Every `d` that reaches the DOM passes
`sanitisePathData` as a last line of defence, and a sanitised glyph is
reported through `onWarning` as `glyph-path`.

## Layout

`src/layout.ts` (pure, tested): page area 1600×1000, margins 80, columns of
640 (gap 64). `flow` continues the line and wraps; `newline`; `column` opens
the next column or a new page when there is no room; `beside`/`below` use a
ref's bounds (unknown ref → `flow`); `center` centres in the remaining page
room; `newpage` moves the page area down 1100. Notes stack in the right
column level with the current writing position.

## Sketch DSL

`src/sketch.ts` (pure, tested): `box ID "Label"`, `circle ID "Label"`,
`note ID "text"`, `row`, `arrow A B "label"`. Tolerates smart quotes,
whitespace, bare labels and `->`; unknown lines land in `warnings`. Rows
top→bottom, nodes left→right, gap 36, node width from label length
(120–320), height 64; arrows join the nearest sides.

## Fonts and licences

- Caveat is © The Caveat Project Authors, SIL Open Font License 1.1. The
  bytes come from `@fontsource/caveat` (WOFF, latin subset); the licence text
  ships in that package (`node_modules/@fontsource/caveat/LICENSE`). Nothing
  is vendored. opentype.js 2.0.0 parses WOFF (verified in Node) but not
  WOFF2, which is why the WOFF file is used.
- Shiki's `github-light` theme is MIT; only the curated grammars in
  `src/highlight.ts` are code-split in.
- tldraw requires a licence key in production (see `docs/QUESTIONS.md`).

## Styles

Import `tldraw/tldraw.css` and `@pen/board/styles.css` (both are imported by
`Board.tsx`). Everything is token-driven: `--color-paper`, `--color-paper-grid`
(26 px dotted grid), `--color-ink*`, `--font-hand`, `--font-mono`.

## Testing

`pnpm --filter @pen/board test` — pure modules only. The executor is tested
against `test/helpers.ts#FakeEditor` (an in-memory `EditorLike`) and a
`ManualTicker`, so pause/resume/finish/cancel are exercised deterministically
without a browser. tldraw is never rendered in tests.

Visual check: play `src/demo/script.ts` through a mounted board.
