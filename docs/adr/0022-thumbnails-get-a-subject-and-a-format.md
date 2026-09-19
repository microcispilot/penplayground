# ADR-0022: The thumbnail gets something to photograph, and a format a card can afford

Status: accepted · 2026-09-18 · amends ADR-0021

## Context

### A camera pointed at an abstraction photographs a diagram

ADR-0021 replaced the hand-drawn sketch with one `gpt-image-1` generation from
a prompt the owner dictated, whose whole input is the session title:

    Design a realistic thumbnail for a YouTube video titled "<title>".
    Not crowded: one clear subject, plenty of empty space, no text.
    Hyper realistic photography, natural light, shallow depth of field.

For a title that names a thing, that works. For a title that names an idea, it
does not: "How Transformers work in LLMs" came back as a photograph of **a
diagram on card, lettered "Treassioner"**, and on a retry a hand-drawn
flowchart reading "Souk cor" and "Wzaci". The model, given nothing physical to
aim at, falls back on the most common image of an explanation — a labelled
diagram — and then invents the labels.

Two negative fixes were tried against the real endpoint and both failed:

- adding *"no letters, words or numbers anywhere in the picture"* changed
  nothing — the same title still produced lettered paper;
- naming the things to avoid (*"never paper, a whiteboard, a screen, a
  printout, a diagram or a chart"*) made it **markedly worse**: it produced
  exactly those, with heavier gibberish.

Naming a thing to an image model summons it. Both attempts were reverted.

### A photograph stored as PNG

ADR-0021 measured the consequence of the same change and left it open: source
2,077 kB, card 434 kB, og 1,303 kB. A row of twenty cards is ~8.6 MB of PNG.
PNG is a lossless format for flat colour and a photograph is neither. The
rasteriser in place — `@resvg/resvg-js`, wrapping the PNG in a one-element SVG
— only emits PNG, so the format could not change without an encoder.

## Decision

### The model that understands the topic names the thing to photograph

- **One more field on a call we already make.** `metaMessages` already asks the
  cheap text model for the card's description, keywords and category. It now
  also asks for **`subject`**: one real, physical thing a photographer could
  point a camera at for this lesson, as a short English noun phrase. *"a server
  rack with glowing processor modules, cool blue light."* *"a clinician's hands
  beside coiled ECG leads and electrodes."* No extra call of any kind: the
  picture still costs exactly one generation and the copy exactly one
  completion.

- **The steering is positive, and the reason is in the prompt.** The copy
  prompt tells the model *why* a camera needs a thing — an abstraction gets
  photographed as a diagram with invented writing on it — so it chooses for the
  right reason rather than pattern-matching a format. It also refuses one class
  of subject outright: **a surface made to be read**. A diagram, chart, screen,
  slide, printout, page, book, note, whiteboard, poster, sign, label, price tag
  or packaging comes back covered in nonsense lettering whatever the rest of
  the prompt says. That exclusion is safe *here* and would not be in the image
  prompt: a text model asked for a noun phrase obeys a constraint, an image
  model summons whatever is named.

- **The image prompt keeps the owner's three lines,** and gains one between the
  first and the second:

      Design a realistic thumbnail for a YouTube video titled "<title>".
      Photograph this: <subject>.
      Not crowded: one clear subject, plenty of empty space, no text.
      Hyper realistic photography, natural light, shallow depth of field.

  The title stays: it is the only thing carrying the session's own flavour, and
  the subject is a thing, not a scene. The image prompt still names nothing it
  does not want in the frame.

- **A missing subject costs a worse picture, never a job.** `subject` is `''`
  when the model returned nothing usable (blank, punctuation, no letter or
  digit), when the copy call failed both its attempts, and on every card
  written before this ADR — `SessionMeta.subject` defaults to `''`, so old
  `meta.json` files and cache entries keep parsing. An empty subject sends
  exactly ADR-0021's three-line prompt. An over-long subject is cut at a word
  boundary at 120 characters like every other field, rather than refused.

- **The picture now waits for the copy, and only when it must.** The two calls
  were independent and ran together. The picture's cache lookup still needs
  nothing and happens first, so a reused picture waits for nothing; only a
  generation joins the copy call, for the one field it needs. They still fail
  apart: a copy that fails leaves a paid-for picture in the cache, a picture
  that fails leaves the copy. `session_thumbnail.done` reports `subject`
  (true/false) and `copyWaitMs`, so a run of sessions where the field stopped
  arriving is visible rather than inferred.

### The card is WebP and the Open Graph image is JPEG

- **`sharp` replaces `@resvg/resvg-js`.** One native dependency out, one in —
  and the new one is an image codec rather than an SVG rasteriser being used as
  one. `resize(w, h, { fit: 'cover', position: 'centre' })` is exactly the
  `preserveAspectRatio="xMidYMid slice"` it replaces, and `toBuffer()` decodes,
  resizes and encodes on libuv's threadpool, so ADR-0021's event-loop guard is
  kept, not weakened. Prebuilt binaries cover both targets, verified rather
  than assumed: `docker run --platform linux/amd64 node:22-bookworm-slim`
  reports glibc 2.36 (sharp's floor is 2.28), installs
  `@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64` with no toolchain,
  and encodes both formats; `@img/sharp-darwin-arm64` covers this machine.
  sharp 0.35 has no install script — `pnpm add sharp@0.35.4` printed no
  `ERR_PNPM_IGNORED_BUILDS` — so `pnpm-workspace.yaml`'s `allowBuilds` needs
  no entry. (0.34 would have needed one.)

- **Two formats, for two audiences.** `thumb.webp` for the card — every browser
  that can run this app decodes it. `og.jpg` for Open Graph, **not** WebP: the
  only place Meta enumerates formats for `og:image` is the `og:image:type` row
  of its Webmasters guide, and it lists `image/jpeg`, `image/gif` and
  `image/png`. X's (archived) Cards documentation does list WebP, LinkedIn and
  Slack document no format list at all. An unfurl that silently shows nothing
  is not worth the kilobytes, and the highest-volume unfurler is the one that
  does not document it.

- **The source does not change.** `source.png` stays exactly as `gpt-image-1`
  returned it, because it is the master every size is re-derived from and never
  a file a browser is sent. One generation, every size — still the rule.

- **The routes say what they serve.** `/thumb.webp` (`image/webp`) and
  `/og.jpg` (`image/jpeg`); `og:image:type` follows the route.
  `/thumb.png`, `/og.png` and `/thumb.svg` keep serving the files earlier
  sessions have on disk, because their records still point at them, and none of
  the three is ever written or re-derived again. **Nothing deletes them
  either**, not even a re-encode: `og.png` was the `og:image` on every share
  page ever posted, and an unfurl cache re-fetches that URL without re-scraping
  the page, so removing it would turn a picture already sitting in someone's
  Slack into a 404. They cost ~1.9 MB a session on a disk the RUNBOOK budgets.

- **Derived files are written through a rename.** `file()` derives a missing
  size on the request path, and after this ADR that path is *hot*: every
  pre-ADR-0022 share page now advertises an `og.jpg` that does not exist yet,
  so the first crawlers to arrive derive it concurrently. A plain
  `writeFileSync` lets a reader in between the truncate and the bytes, under a
  `Content-Length` measured a moment earlier. Write-then-rename is what the
  lesson-memo cache already does, and it is atomic.

- **The card-copy cache is invalidated.** `session-meta-cache.json` goes to
  version 2, which a version-1 file fails to parse — and an unparseable file is
  already read as a cold cache. Without it a scope cached before this ADR would
  replay `subject: ''` for good: the entry parses fine, because the field
  defaults, so its thumbnail would silently keep the title-only prompt. One
  cheap copy call per scope (~$0.0002) is the price of not having that.

- **`thumbnails:backfill --reencode` moves the sessions that already exist, and
  spends nothing.** A session written under ADR-0021 has a 434 kB PNG card and
  the generation that paid for it still on disk, so the new pair is a
  re-derivation: no model is asked anything, the PNG pair is deleted, and the
  record is pointed at `thumb.webp`. It refuses to run alongside `--redraw`, so
  a run that costs money is never mistaken for one that cannot.

- **`meta.json` is version 3.** `render.{sourceBytes, cardBytes, ogBytes}`
  stop claiming to be PNG counts. Version 2 is read through the old names and
  never written again.

## Consequences

### What it cost, measured on 2026-09-18

Five titles through the whole real path — `thumbnails:probe`, ten API calls,
**$0.0827**:

| | before | after | delta |
|---|---|---|---|
| copy call | 372 in / 55 out, $0.000140 | 642 in / 67 out, $0.000209 | **+$0.000068** |
| image prompt | 52 text tokens | 67 text tokens (64–69 across five) | **+$0.000075** |
| calls per session | 1 copy + 1 generation | 1 copy + 1 generation | **0** |

$0.00014 against $0.0163 for the generation it steers: under 1 %, and the
per-session bill in docs/COST.md does not move.

### What it weighs, same pixels encoded both ways

| | PNG (ADR-0021) | today | |
|---|---|---|---|
| card 640 × 360 | 442 kB average | **15 kB** WebP q82 | 29× |
| og 1200 × 630 | 1,525 kB average | **49 kB** JPEG q82 | 31× |

Deriving both takes **32 ms** against ~250 ms for the rasteriser it replaced. A
row of twenty cards went from ~8.6 MB to ~0.3 MB.

### What the pictures came back as

Objectively, and only objectively: across the five generations, **none** came
back with legible invented words. One — the chip in a server rack — carries
faint glyph-like marks on a circuit-board silkscreen, unreadable at any size
the card is shown at. On the run before the "surface made to be read" exclusion
was added, two of the same five did carry rendered characters: legible price
tags reading "$1.99 / $2.99 / $3.99" on a supermarket shelf, and pseudo-writing
on task cards pinned to a whiteboard. Both times the model had named a surface
whose purpose is to display characters. That is why the exclusion exists, and
it is the measurement that put it there.

**Whether any of them is a good thumbnail is not settled here.** That is the
owner's call and only theirs; the five sets are under
`.pen-data/screens/thumbnails-adr-0022/` to be looked at rather than argued
about.

### What is not settled

- **Quality 82** for both encoders is a default with a measured price, not a
  judgement. It is one constant (`ENCODE` in `services/api/src/thumbnails.ts`)
  away from moving, and moving it is the owner's call.
- **Meta's crawler was not exercised.** The JPEG choice follows Meta's
  documented list; whether its crawler would in fact render a WebP is unknown
  and could only be answered by putting a live public URL through the Sharing
  Debugger.
- **The API image itself was not built or deployed.** sharp was verified
  directly inside `node:22-bookworm-slim` on linux/amd64 (glibc 2.36, prebuilt
  binaries, both encoders), but no `deploy/deploy.sh` run happened and no
  session on the production data has been re-encoded. `thumbnails:backfill
  --reencode --dry-run` against the live database is the next thing to run,
  and it is the owner's to start.
