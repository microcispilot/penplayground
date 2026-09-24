# ADR-0048: The voice engine is a setting, bound per session

Status: accepted · 2026-09-24

Extends ADR-0036 (feature flags are a matrix) and ADR-0017 (the synthesis
cache). Supersedes the single `PEN_TTS_PROVIDER=fish-cloud` engine.

## Context

The owner:

> *"We should be able to switch between Fish Audio and Cartesia at any time
> through feature flags, for all platforms, users, or specific platforms or
> users like subscriptions. The default should be Cartesia. This should be
> done properly without any mistakes or problems, and the system should not
> mix them… a voice service… the underlying flow should not worry to check
> the flag for everything every time."*

What was true before: one engine, chosen at boot by `PEN_TTS_PROVIDER`; one
voice catalogue (Fish's); one store of taught lessons; the room took a
`synthesizer` and a `voiceFor` from the services and never knew whose they
were. Feature flags answered yes or no, on plan × platform × visitor, and
nothing answered "which".

Cartesia, measured on 2026-09-24 against their `/tts/bytes` endpoint with
`sonic-3.6`, raw `pcm_s16le` at 44.1 kHz: first byte in 170–180 ms, against
Fish's ~700 ms on the free tier; `generation_config.speed` and `emotion`
accepted; `[laughter]` and `<volume ratio/>` inline. Their library
(`GET /voices`) is 988 public voices, all Cartesia's own, with no usage or
rating exposed and an order that is neither by date nor by name — their own.

## Decision

### 1. A setting is a flag that carries a value

`packages/contracts/src/settings.ts`: `ChoiceRule` has the same axes as a
`FeatureRule` — default, plans, platforms, cells, visitor — plus
**participants**, answers for named accounts. It resolves in this order:
the participant; the visitor's answer; the cell; the plan; the platform; the
default. The plan wins over the platform because there is no AND for a
value, and "a subscription's engine" is the more deliberate statement.

`SETTINGS.voice_engine` is the first setting: values `cartesia` and `fish`,
built-in default **`cartesia`**. Settings live in the same stored document
as the flags, under their own names, with the same revision, history,
rollback and audit; the console edits them beside the flags (a select per
cell instead of a toggle, and a list of specific accounts). A save that
leaves `settings` out keeps them as stored. A value the setting does not
name is refused with the place named.

### 2. The voice service binds once

`services/api/src/voice/service.ts`: `VoiceService` holds one
`VoiceBinding` per engine this server has a key for — the engine's
synthesizer, behind its own store of taught lessons, and its own voice
catalogue — and `bind(who)` resolves the setting **once**, when a session is
created, and hands the room the binding whole. The room takes a
synthesizer and a `voiceFor` as it always did; it does not know which
engine it is on and has no way to change it. The setting is never read
again during a session, so a change reaches the next session and never a
lesson in progress, and one session cannot mix engines. `LiveRoom.voice`
records the engine and the synthesizer id for the books.

A setting can name an engine a server has no key for — a document written
for production, read by a checkout with one key. Then the session still
speaks, with the first engine that exists in the catalogue's order, and
`voice.engine_fallback` says so in the log and the observer. In the
single-engine development providers (`fish-bridge`, `silent`) every engine
name is that engine, so the setting resolves without a fallback.

`PEN_TTS_PROVIDER=cloud` (the old `fish-cloud` reads as it) offers the cloud
engines by key: `CARTESIA_API_KEY`, `FISH_AUDIO_API_KEY`. Neither is an
error at boot; both missing is.

### 3. Each engine has its own voices, and its own store

The expert catalog's `voices` is now per engine:
`{ fish: { en: id }, cartesia: { en: id } }`; an older catalog's single map
reads as Fish's. `voices.fish.json` is the catalogue that was
`voices.json`; `voices.cartesia.json` is built by
`scripts/build-cartesia-voices.ts` from Cartesia's library. With no usage
or rating in their API, the library's own order is the quality signal: per
language and gender the first 24 voices are the pool, the first 8 of them
flagship (weighted double), and voices described as characters, games or
children are left out. `scripts/assign-voices.ts` assigns per engine, and
keeps what is assigned. The two catalogues share no id, so a voice can
never be sent to the wrong engine (tested).

Stored takes are one engine's audio: `lesson-voice-fish` (the old
`lesson-voice`, renamed on first boot) and `lesson-voice-cartesia`, each
with the `PEN_TTS_CACHE_MB` ceiling. The engine id is in every take's hash
already (ADR-0017), so a shared directory would also have been safe; a
directory each keeps "never mixed" visible on disk.

### 4. Delivery, in each engine's dialect

The vocabulary the model writes (ADR-0047) is the same for both. Fish gets
the tone as a bracket cue in front and the inline cues as they are.
Cartesia gets the tone as `generation_config.emotion` from Sonic's own list
(`content`, `curious`, `confident`, `happy`, `enthusiastic`; English only, by
their rule), a laugh as their `[laughter]`, a beat as an ellipsis, an aside
as `<volume ratio/>`; a stressed word and a sigh, which Sonic has no
primitive for, are simply not said. The synthesis request now carries the
room's `language`, and the take hash includes it.

Pricing: Cartesia bills a credit per character; the Startup plan is $49 for
1.25M, which is $39.2 per million, and that is the rate on `cartesia:*`
engine ids. Fish stays at $15 per million bytes.

## Consequences

- `services.synthesizer` and `services.voices` are gone; `services.voice`
  binds, and `services.ttsCaches` is one cache per engine for the status
  pages.
- Rooms record `room.voice_engine` at creation. The end-of-session books
  carry the engine's synthesizer id as before.
- The default moving to Cartesia means every stored Fish take is idle until
  a rule names Fish again; the ceiling evicts on its own.
- `deploy.sh` forwards `FISH_AUDIO_API_KEY` and `CARTESIA_API_KEY` from the
  operator's shell like the other secrets, masked in its log.
- Whether Cartesia's voices *sound* better is the owner's judgement; three
  probe sentences (control, slowed with emotion, inline tags) are in the
  session's scratchpad beside the Fish ones.
