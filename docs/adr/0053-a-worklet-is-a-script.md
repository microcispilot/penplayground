# ADR-0053: A worklet is a script

Status: accepted · 2026-09-25

Extends ADR-0046 (the recognizer needs a witness) and the Content-Security-
Policy decision of 2026-09-17 (`apps/web/csp.ts`).

## Context

`apps/web/e2e/session.spec.ts` — a learner asks a spoken question and finds
it in the recap — failed on `main` at 9dddfe9, on an untouched checkout, with
the recap saying *"0 questions"*. Instrumented (`window.__penRoomStore`
subscribed, `getUserMedia` and `AudioWorklet.addModule` wrapped, a stack on
`MediaStreamTrack.stop`):

- the microphone went `starting` → `idle` 300 ms after the grant, with no
  error reported and nothing in the console;
- `audioWorklet.addModule(blob:…)` rejected with a bare `AbortError`:
  *"Failed to load worklet module script … (a dependency or cross-origin
  script failed to load)"*;
- with the dev server's policy switched to report-only
  (`PEN_CSP_REPORT_ONLY=1`) the same module loaded in 300 ms, the microphone
  reached `listening`, and the question was answered.

Two faults, one under the other.

**The policy.** It granted `blob:` under `worker-src` "for the microphone
capture AudioWorklet". A worklet is not a worker to CSP3: `addModule` is a
script request, governed by `script-src`, and `script-src` had no `blob:`.
The web container serves the same policy (`deploy/web/nginx.conf`, generated
from the same source), so the microphone has not opened in production since
the policy was enforced. Chrome reports the refusal as a promise rejection
only — no console line — which is why a suite that watches the console for
violations (`csp.spec.ts`) never saw it.

**The silence.** `Microphone.start` treated any `AbortError` as its own
`stop()` racing the startup and set `idle` without calling `onError`. The
room then started the recognizer on a microphone that was not listening,
which is exactly the state ADR-0046 guards against: with no witness, every
transcript that arrives while a voice plays is dropped as echo. So since
ADR-0046 a learner could not ask anything while the expert was speaking, and
before it the recognizer worked *only* because the microphone was dead and
the guard did not yet exist. Nothing reached Sentry.

**The harness.** The e2e's fake recognizer handed words to the product
without making a sound, so once the microphone worked the guard still had no
witness to believe them.

**The race under it.** With the microphone alive, the timeline spec on real
Chrome still lost the question one run in three, with the expert already
"listening" and no transcript sent. React's StrictMode mounts a room session,
disposes it, and mounts the one that lives; `start()` already returned early
on the disposed one, but its `.then(enableMic)` still ran, opened a
microphone, and — when its grant resolved last — started the recognizer that
became the browser's active one. Every word then went to a conductor whose
phase was `ended`, which returns without a sound, while the live session's
microphone confirmed the speech and interrupted the lesson with nothing to
say.

## Decision

- `script-src` carries `blob:`. The comment beside it says why, and
  `csp.test.ts` asserts it. `worker-src` keeps `blob:` for the resampler
  worker Vite serves from a blob in dev.
- A refused worklet module is `PEN_MICROPHONE_WORKLET_FAILED`: the load is
  wrapped, the error is named as ours with the browser's as its `cause`, and
  the startup's catch reads an `AbortError` as a cancellation only when its
  own `AbortController` fired. The state is `error`, `onError` fires once,
  and the room reports it to Sentry through the existing `stt` path.
  `packages/voice/test/microphone.test.ts` holds both halves: the refusal is
  reported, a real `stop()` mid-load is still a quiet `idle`.
- `enableMic` on a disposed session is a no-op, and a session disposed while
  its grant was pending releases the grant and leaves without touching the
  store, the audio room or the recognizer, which are the live session's.
  There is no unit harness for a whole room session; the proof is
  `timeline.spec.ts` and `session.spec.ts`, three runs each on Chromium and
  Chrome, where the race showed once in three before.
- The fake speech harness owns the microphone too: `getUserMedia` for audio
  returns a stream the harness drives — a working microphone's noise floor,
  and a voiced tone (140 Hz with two harmonics, band-limited so the presence
  detector's 8 kHz decimation cannot alias it) for 900 ms whenever a sentence
  is said, with the recognizer's final landing at 600 ms, after the
  segmenter's 240 ms confirmation — the words go once the product's own
  level meter has read the tone, plus that window, because a fixed delay let
  them arrive before the confirmation on real Chrome. `askByVoice` resolves
  once the words have landed. Everything from the stream inward — the harmonic VAD, the barge-in,
  the guard — is the product's own code on a real signal.

- The fake media device's own capture is a beeping tone, which the harmonic
  detector confirms as speech: once the microphone was alive, every spec
  that had not installed the harness barged in on its own lesson two seconds
  in. The Playwright config points the fake device at
  `e2e/fixtures/quiet-microphone.wav` — one second of a working microphone's
  noise floor, looped — so a room hears a quiet learner unless a spec speaks.

## Consequences

- The next deploy re-opens the microphone for every learner. Barge-in and
  spoken questions during playback work again; `echo_dropped` should fall
  to the genuine echo cases.
- A verification gate that greps for `Tests .*failed` misses Playwright,
  which prints `N failed` without the prefix. `pnpm verify`'s exit code is
  the gate.
- A future policy change that breaks a worklet fails `session.spec.ts` and
  reaches Sentry as `PEN_MICROPHONE_WORKLET_FAILED` rather than a silent
  microphone.
