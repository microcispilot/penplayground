# ADR-0021: Session thumbnails are generated photographs, and every background job bills to the host's plan key

Status: accepted · 2026-09-18 · amends ADR-0013

## Context

ADR-0013 gave the model a bounded whiteboard vocabulary — label, box, circle,
arrow, line, trace, bars, underline, highlight on a 12 × 7 grid — and a
deterministic renderer that drew it as paper-and-ink SVG. It met every
constraint it was written against: a tenth of a cent, off the critical path,
on-brand, cached per lesson.

The owner's verdict on the result: *"these thumbnails are really horrible. They
show the board, but should not. your prompt is wrong."*

The prompt was not the problem, and rewording it could not have been the fix.
A vocabulary of labels, boxes and arrows **can only ever draw a board**. The
thumbnail is what a learner sees before they know anything about the session,
in a grid beside twenty others; it has to work the way a YouTube thumbnail
works, and no arrangement of arrows does that.

Separately: `modelFor(plan)` already picks `OPENAI_API_KEY_FREE|STANDARD|
PROFESSIONAL` from the **host's** plan, once, so every lesson call bills where
it should. The background card job did not. `buildServices` handed it one
model built on the free key, so a Professional host's card was drawn on the
free key and — when the default changed — the reverse was equally possible.
Per-plan spend was therefore not readable, and one tier's rate limit could eat
another's.

## Decision

### The picture is generated, and generated once

- **One `gpt-image-1` call per session**, from a prompt the owner dictated and
  which is kept close to their words (`thumbnailImagePrompt`):

      Design a realistic thumbnail for a YouTube video titled "<title>".
      Not crowded: one clear subject, plenty of empty space, no text.
      Hyper realistic photography, natural light, shallow depth of field.

  The session title is the whole input. No text is asked for on purpose: image
  models spell badly, and the title is already printed beside the card.

- **Raster, not vector.** A vector would scale to every size from one file,
  which is exactly the property we want — but the picture is a photograph, and
  a photograph has no vector form. `gpt-image-1` returns base64 PNG and nothing
  else; tracing it into paths would give back a drawing, which is the thing
  being removed. The same property is bought a different way:

- **One generation, every size.** The call always asks for **1536 × 1024**, the
  largest landscape the model offers. Those bytes are stored as `source.png`
  and **every** rendered size is a downscale of them — the 640 × 360 card and
  the 1200 × 630 Open Graph image today, and any size added later. The API
  bills per generation, not per pixel, so the number of sizes served must never
  change the bill. Downscaling is `resvg` drawing the PNG into an SVG of the
  target size with `preserveAspectRatio="xMidYMid slice"` (scale to fill, crop
  centred), through `renderAsync` so the event loop keeps turning — the guard
  ADR-0013 won back is worth more now, because the source is heavier.

- **Quality is one setting.** Measured against the real endpoint on 2026-09-18
  at 1536 × 1024: `low` = 400 image tokens, ~11 s, **$0.0163**; `medium` = 1568
  tokens, ~18 s, **$0.063**. Downscaled to the width a card is actually read at
  the two are not tellable apart, so `PEN_THUMBNAIL_QUALITY` defaults to `low`
  and changing it is one line. `high` has not been measured here, and the
  saved-cost table says so rather than inventing a number.

- **The copy is unchanged and now separate.** `metaMessages` still asks the
  cheap text model for description, keywords and category — that half was never
  the complaint. The two calls are independent, run together, and fail apart:
  a session whose picture never arrives keeps its copy and its placeholder; a
  picture that was paid for is cached even when the copy call fails, so it is
  never bought twice.

- **One picture per lesson, not per session.** The picture is cached under the
  same scope as the card copy — the lesson memo's canonical topic + band +
  persona + language — with a digest of the **title**, because the title is the
  whole prompt (`FileThumbnailImageCache`,
  `<data>/onten/thumbnail-images/`). A repeat session on a topic gets the first
  one's bytes for nothing and reports it the way every other reuse does
  (ADR-0011): one `image` stage sample with `reused: true` and `savedUsd` —
  the price actually recorded for the original generation — and no cost lines.
  At ~$0.016 a generation this is the difference between a popular topic
  costing one cent and costing one cent per learner.

- **Cost is a first-class line.** `CostComponent` and `StageName` gain `image`.
  One generation is two cost lines — `tokens_in` for the prompt, `tokens_out`
  for the picture — priced from `IMAGE_PRICING` ($5/M text in, $40/M image out
  for `gpt-image-1`, verified 2026-09-18). They reach the session ledger, the
  telemetry endpoint, the Insights tab ("Picture 400 image tokens · 1
  generation") and PostHog (`cost.imageUsd`, `cost.imageTokensOut`).

- **What was deleted.** The thumbnail half of `metaMessages`; `SketchSpec` and
  every element schema, constant and normaliser in
  `packages/contracts/src/thumbnail.ts`; `packages/board/src/thumbnail.ts`
  (the renderer, ~840 lines) with its tests and SVG snapshots; the
  `@pen/board/thumbnail` export; the hand-font loading in the API. Sessions
  taught before this ADR still have a `thumb.svg` on disk and a record pointing
  at it, so the route keeps serving those files — nothing writes a new one, and
  `thumbnails:backfill --redraw` replaces them when the owner decides to spend
  it.

### Every call bills to the host's plan key

- `SessionMetaInput` carries `billTo: KeyOwner`, and the job resolves **both**
  models from it per job: `modelFor(billTo)` and `imageFor(billTo)`. A room
  passes `args.host.plan`, so a free learner's card copy and picture bill to
  the free key and a Professional host's to theirs — the same key their lesson
  ran on. There is no fallback between plan keys, as there never was for the
  lesson.
- `KeyOwner = PlanCode | 'platform'` (contracts) names the fourth key.
  `OPENAI_API_KEY_PLATFORM` is for work belonging to **no learner** — the
  thumbnail backfill, the probe, pack prewarming — and nowhere else. The
  backfill passes `billTo: 'platform'` and refuses to run without that key
  rather than quietly charging a learner's plan. Both env templates say this.

## Consequences

- **Cost.** ~$0.0163 per *lesson* (not per session) at `low`, against
  ~$0.001 before — about 16×, and still under 6 % of a session's marginal cost
  next to $0.22 of voice. Every repeat on a topic is free and says what it
  saved. The daily spend breaker (ADR-0016) sees it like any other spend.
- **Latency.** Unchanged where it matters. The job still waits on
  `room.firstAudio` before it is enqueued, and a generation takes ~11 s in the
  background. A card appears ~10 s later than it used to, which is a card, not
  a lesson.
- **Bytes.** A photograph is not a 20 KB SVG. Measured on a real generation:
  source 2,077 kB, card 434 kB, og 1,303 kB — ~3.8 MB per session on disk, and
  a 640 × 360 card is ~434 kB over the wire. PNG is a poor format for
  photographs; WebP or JPEG would be roughly an order of magnitude smaller but
  needs an encoder dependency (resvg only emits PNG), which is a separate
  decision and not taken here.
- **Taste is not settled by this ADR.** Whether the pictures are any good is
  the owner's call and only theirs; `thumbnails:probe` exists so they can be
  looked at rather than argued about.
