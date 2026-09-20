# ADR-0029: A thumbnail carries words, and the model is handed them

Status: accepted · 2026-09-19

Amends ADR-0021, whose picture prompt ended with "no text", and extends
ADR-0022's `subject` with a second field on the same call.

## Context

The owner looked at the generated thumbnails and said: *"make sure the images
that are generated has some titles or text on them, not just a pure image of
a place."*

That reverses one line of ADR-0021, and it is worth being precise about which
line and why it was there. ADR-0021 ended the picture prompt with "no text"
because a model given only a title **invents** lettering: told "How
Transformers work in LLMs" and nothing else, `gpt-image-1` photographs a
diagram on paper and covers it in letter-shaped marks that spell nothing.
ADR-0022 fixed the cause — a `subject` the camera can point at — and left the
"no text" line standing, because nothing had asked for text.

The instruction and the old finding are not in conflict once the cause is
named. **The nonsense came from the model choosing what to write.** Handed an
exact string it sets type instead of inventing it, and `gpt-image-1` sets
short type well.

## Decision

### A `headline` field, on the call that was already being made

`ModelSessionMeta` gains `headline` after `subject`, so the copy call returns
it for the price of a few output tokens and the number of API calls per
session does not move. The order is the reasoning order: the model commits to
the description and the category, names the thing to photograph, and only
then writes the words to print on it — which is the order a designer works
in, and means the headline is written knowing what the photograph will be.

`META_MAX_HEADLINE_WORDS = 4`, `META_MAX_HEADLINE_CHARS = 26`. Short because
length is what breaks it: a few words come back as typography and a sentence
comes back as a smear, and the failure is not graceful. Four words is the
working size of a real thumbnail headline anyway.

### The prompt says "this text", never "no text"

`thumbnailImagePrompt` now has two shapes. With a headline it asks for
composition first — one subject to one side, clean space to the other — and
only then for the words to be printed into that space, "spelled exactly as
written". Without one it is ADR-0021's prompt, unchanged, including its "no
text" line.

Two rules hold it together, both learned by measurement rather than taste:

- **Say what to draw, never what to avoid.** ADR-0021 measured this twice:
  naming a thing to an image model summons it. The one place this prompt
  comes close is "the only words anywhere in the frame", which is phrased as
  a property of the headline rather than as a prohibition on anything else.
- **The title is context, not a second candidate string.** With a headline
  the first line is `about <title>`, unquoted, where it used to be
  `titled "<title>"`. Measured: with the title quoted, a generation came back
  reading "WHY DEADLINES SLIP ON SOFTWARE TEAMS" where the headline was "WHY
  DEADLINES SLIP". Given two strings shaped like words to set, a model will
  sometimes set the wrong one. Unquoting it ended that.

### Non-Latin scripts get no text, on purpose

`thumbnailHeadline` refuses anything outside the Latin script. A lesson
taught in Persian gets a Persian headline from the copy call, and
`gpt-image-1` renders Arabic script as decorative marks — text-shaped,
meaningless, and **worse than no text**, because it looks like language and
is not. A learner reading Persian is better served by a clean photograph.

The check is on the script, not on a list of languages, so a Latin-script
language nobody thought about still gets its words and a non-Latin one
nobody thought about still gets none. One stray character from another
script refuses the whole line: half a headline set correctly and half in
marks is the worst outcome available.

An empty headline is therefore a supported result rather than a failure, and
the prompt it produces is exactly ADR-0021's.

### One more word on the subject list

The forbidden surfaces in the copy prompt gain `sticky note`, `card`,
`ticket`, `receipt` and `form`, and one positive redirect: *"If the first
thing that comes to mind for this topic is something people write on, name
the tool, the material, the machine or the hands instead."*

This was not speculative. "Why deadlines slip on software teams" produced
"developers' hands rearranging colored task cards", and the cards came back
covered in the nonsense lettering ADR-0021 is about — the headline was
perfect and the background was not. The exclusion list alone did not stop it
(the model does not think of a task card as a surface made to be read); the
redirect did, twice in a row, producing wooden blocks and coloured tokens
instead. The exclusions are safe **here** and would not be in the image
prompt, which is ADR-0022's point restated.

## Consequences

- **No extra cost.** One copy call, one generation, unchanged. The headline
  adds a handful of output tokens to a call that already runs.
- Measured against the real endpoint on 2026-09-19, quality `low`, eleven
  generations across nine titles: every headline was spelled correctly. The
  two defects were both prompt-shape problems and both fixed above — one
  generation set the title instead of the headline, and two chose a
  read-surface subject whose background lettered itself.
- `SessionMeta.headline` defaults to `''`, so every `meta.json` and cache
  entry written before this field keeps parsing and keeps its picture. Older
  sessions do not get text until they are re-generated; nothing forces that,
  and `thumbnails:backfill` re-encodes rather than re-generates.
- `session_thumbnail.done` reports `headline: boolean` beside `subject`, so a
  run of sessions losing the field is visible. It is `false` and correct on a
  non-Latin-script lesson, which is the one case where the signal needs
  reading with the language in hand.
- Whether a given picture *looks* right is still the owner's call and no test
  claims otherwise (`CLAUDE.md`, "Real credits are for correctness, never for
  taste"). `pnpm --filter @pen/api thumbnails:probe` runs the whole real path
  for a list of titles and writes the files to look at;
  `PEN_PROBE_DIR=<name>` keeps a run's output separate from the last one's.
