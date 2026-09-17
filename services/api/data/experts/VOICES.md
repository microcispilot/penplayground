# Voice catalog

`voices.json` is the curated set of Fish Audio **official** voices (author
"Fish Official", fetched 2026-09-16 via `GET https://api.fish.audio/model`),
filtered to narration/educational/conversational/professional voices; celebrity
clones and character voices are excluded. Six flagship English voices (Sarah,
Laura, Hannah, Ethan, Jordan, Adrian) are ranked first.

An expert's voice is chosen at session time by `ExpertVoices.resolve(expert,
language)`: same gender, the session's language (locale first, then language
prefix, then English), flagship voices weighted first, spread across personas
by a stable hash of the expert id so one persona always sounds the same and a
voice is shared by only a handful of personas.
