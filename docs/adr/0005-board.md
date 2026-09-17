# ADR-0005: tldraw 5 as the board engine with custom ink-text, stroke and code shapes

Status: accepted · 2026-09-16

## Context
tldraw 5.4 (2026-09): `draw` shapes store delta-encoded `segment.path`
(`b64Vecs.encodePoints`), `animateShape`, snapshots, `hideUi`, custom
`ShapeUtil`. Rich text disables code blocks; `toRichText` is not markdown.
Production requires a license key (trial 100 days; hobby key = watermark,
non-commercial; commercial by application). Excalidraw is MIT but has a weaker
programmatic API and slower cadence.

## Decision
- `packages/board` wraps tldraw with `hideUi`, read-only for the expert's layer,
  and registers custom shapes: `ink-text` (handwriting glyph outlines from an
  OFL handwriting font via opentype.js, revealed stroke-by-stroke),
  `ink-stroke` (progressive `draw` segments paced by arc length), `code-block`
  (Shiki-highlighted, typewriter reveal), `md-block`.
- A `BoardExecutor` maps `board` cues to shapes and reports progress to the
  conductor; a `CameraDirector` follows the hand with 400–700 ms eased moves.
- The engine sits behind a `BoardRenderer` seam so Excalidraw could be swapped
  in if licensing dictates; nothing outside `packages/board` imports tldraw.
- Also the tldraw introduced AI and llm related features like annotation, that can be used when a user wants to annotate something on the board. 

## Consequences
Human-like writing is achievable and deterministic. The tldraw commercial
license is a purchase decision listed in `docs/QUESTIONS.md`; development on
localhost needs no key.
