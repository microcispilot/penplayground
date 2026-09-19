# ADR-0013: Session thumbnails — one background structured-output call, a sketch DSL, a deterministic SVG renderer

Status: superseded in part by ADR-0021 · 2026-09-17

> **ADR-0021 (2026-09-18) replaced the picture.** The sketch DSL, the
> deterministic renderer and the thumbnail half of the prompt are gone: the
> thumbnail is now one `gpt-image-1` generation per lesson, downscaled to every
> size we render. What survives from this ADR is the background job, the card
> copy call, the per-lesson cache, the storage layout, the routes and the
> backfill. Read ADR-0021 for the picture and for which key a background job
> bills to; everything below describes the design it amends.

## Context
Every session card (Home, My sessions, the saved-session page, the share
page's Open Graph image) showed one of three canned placeholder sketches.
A real thumbnail must (a) cost almost nothing, (b) never delay the first
audio, (c) look like the board — paper, dot grid, Caveat handwriting,
marker strokes — and (d) work where SVG does not (social scrapers).

Alternatives considered: rasterising a board frame from the ledger (needs
Chromium per session, ~seconds, and the first page is rarely the key idea);
image generation models ($0.02–0.04 per image, off-brand, slow); asking the
model for raw SVG (unbounded, unsafe to embed, and the model cannot draw
Caveat); prompting for the sketch in the lesson-plan call (would put more
tokens on the critical path and the plan call is on the session model).

## Decision
- **One call, four things.** Right after the lesson plan resolves, the room
  registry enqueues a `SessionMetaJob`. It makes ONE `complete()` on the
  cheapest model (`PEN_LLM_OUTLINE_MODEL`, the free-plan key) returning
  `SessionMeta { description ≤ 160 chars, keywords 3–6, category, thumbnail }`
  as a strict structured output. The prompt opens with the same persona +
  level prefix and the same `cacheKey` as the plan call, so the prefix is
  served from the prompt cache when both use the same model (the default).
- **Sketch DSL, not pixels.** `SketchSpec` (`packages/contracts/src/thumbnail.ts`)
  is a 12 × 7 grid over a 16:9 card with at most 12 elements from
  {label, box, circle, arrow, line (curve/dashed), bars, underline, highlight},
  two inks (`ink`, `accent`) and a highlight wash. The model-facing schema is
  bound-free (strict mode) and `normaliseSessionMeta` clamps into the
  contract — a slightly moved sketch beats no sketch.
- **Deterministic renderer** (`@pen/board/thumbnail`): draws on the board's
  own 1600 × 900 page with the board's hand primitives (wobble, overshoot,
  `STROKE_STYLE`), Caveat outlines from opentype.js (latin + latin-ext +
  cyrillic subsets, squiggles for anything else), literal sRGB colours
  converted from the paper/ink tokens, a dot-grid pattern, glyphs deduplicated
  into `<defs>` at unit size and placed with `<use>`. Self-contained SVG,
  19–26 KB for full sketches; byte-identical for the same spec and seed.
- **Storage and serving.** `<data>/sessions/<id>/{thumb.svg, thumb.png (640×360),
  og.png (1200×630), meta.json}` next to the ledger; PNGs rasterised in-process
  with `@resvg/resvg-js` (≈ 50–60 ms each). `sessions.thumbnail` stores the
  API-relative path once the SVG exists (null = not ready); `description` and
  `keywords` are new columns (migration `0001_session_meta`). Routes
  `GET /api/sessions/:id/{thumb.svg,thumb.png,og.png}`: public sessions are
  public, long-cached, ETag/304; private ones are host-only, `private`.
  The share page uses `og.png` (scrapers rarely rasterise SVG) and the
  description.
- **Fail-safe and bounded.** Two background jobs at a time, one retry, then
  the deterministic `BoardThumb` stays. The client shows the real image over
  the placeholder once loaded; the saved-session page polls the record on a
  slow back-off for fresh sessions only.

- **One card per lesson, not per session.** The card describes the lesson, so
  it is cached under the lesson memo's own scope — canonical topic + band +
  persona + language — with a digest of the plan it describes
  (`FileSessionMetaCache`, `<data>/onten/session-meta-cache.json`, beside
  `lesson-memo.json`). The second session on a topic reuses the description and
  the sketch with **zero model calls**, and says so the way every other reuse
  does (ADR-0011): one `llm` stage sample with `reused: true` and `savedUsd`
  (the recorded cost of the call it replaces, or the fresh estimate), no cost
  lines, and `reused` in `meta.json`. A re-planned lesson has a different
  digest and is drawn again; one scope keeps one card, and the file is capped.
  The sketch is re-rendered per session (its own seed), so two sessions on a
  topic look like the same idea drawn twice by the same hand, not a copy.
- **Backfill.** `pnpm --filter @pen/api thumbnails:backfill [--limit N]
  [--dry-run]` walks the sessions with no sketch, newest first, and runs them
  through the same queue (two at a time) and the same cache — one session per
  lesson first, so the rest cost nothing. A session whose files are already on
  disk only has its record patched; a session still being taught is left to its
  own job. The dry run prices the work and writes nothing.

## Consequences
≈ $0.0005–0.001 per session at luna prices (≈ 1.4k input, ≈ 0.6k output
tokens) — but only for the first session on a lesson; every repeat is free and
reports what it saved. Render + raster ≈ 120 ms of CPU off the critical path,
paid per session either way. Sessions created before this ADR have a backfill
now. The cache is one JSON file on the node's disk: a second node would want it
in Postgres, which is the same seam (`SessionMetaCachePort`).
