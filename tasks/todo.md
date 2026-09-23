# Todo

- [x] **Settings previews are written on.** The six board swatches carry real board work (Pythagoras: a labelled right triangle, a² + b² = c², 3² + 4² = 5²) instead of a bar, drawn once in chalk and once in marker by `gpt-image-1` on a transparent ground (`pnpm --filter @pen/api board:handwriting`, two generations, medium quality) and shipped as alpha masks tinted by each board's own `--color-ink` — so the same writing is white chalk on slate, black marker on cream, and the learner's chosen colour on the dot. Previews 74 → 112 px; the colour dots sit on one line on a fixed three-row grid whether or not a plan tag hangs under them; board names wrap instead of truncating on a phone. `apps/web/e2e/ui-settings.spec.ts` measures both and captures light/dark × desktop/iPad/iPhone.
- [x] **Jev where a decision beats a language model (ADR-0039).** Every model call in a session read against one test — is this a *decision* the room already has the *words* for? Grading was the one that bundled both: a check-in cue already carries the question, the reference answer and the explanation, and the model was still composing "exactly — a vector is a list of numbers" on every answer (~1 s to first token). Now `JevGrader` decides the verdict (one choice question, `GRADE_MIN_CONFIDENCE = 0.7`) and the expert says `checkFeedback` — verdict, the lesson's own `explain`, "let's keep going" — in fifteen languages; the model grades as before when there is no grader, no key, an unsure answer or a language without lines. `PEN_GRADE_PROVIDER=jev|model` (runtime setting), `/api/health.grade`. **Measured** (`pnpm --filter @pen/api grade:probe`, TypeSafe direct, 12 real answers, 2026-09-23): 10 of 12 decided above the threshold and all 10 match the teacher column; the two that fell to the model were correct answers at 0.55 and 0.60 (safe direction); latency p50 210 ms, p95 368 ms; $0.0000216 per grade against a `grade` model call. Not Jev's, and why: intake (a translation), recap (a taste call the owner should make), the out-of-scope decision (Onten's status), anything in the browser's barge-in path. Tests: `grading.test.ts`, `grade-room.test.ts`.
- [x] **Every decision a visitor makes is an event, and every refusal says why (ADR-0038).** Before the owner's signed-out test: an audit found Start on Home sent no analytics event (and bumped the visit counter before the input was checked), no CTA outside a room was an event, six visit counters were never incremented, every refusal was invisible, the room's own interactions never reached PostHog, pause/resume/end/pace were recorded by nobody, email sign-in left the header saying "Sign in", an uncaught route error was Hono's plain-text 500 with no Sentry event, the monitor was installed too late for a first-render crash, and page views captured the first load only. Now: `ActionName` (closed, tested disjoint from `InteractionName`) + `trackAction` on every CTA; `anonymous`/`plan`/`platform` on every event; `session_refused {reason}`, `participant_issued`, `session_viewed`, `interaction` (ledger copy) and `session_error` from the API; `app.onError`; `installMonitor` before the first render; `capture_pageview: 'history_change'`; the email flows through the provider. Cost: `PEN_MAX_FREE_SESSIONS_PER_IP_PER_DAY` (12) closes the mint-another-anonymous hole. Tests: `observability.test.ts` (API), `analytics-privacy.test.ts` (app), `telemetry.test.ts` (contracts), the integration test asserts the forwarded interactions. RUNBOOK § 4 "Following one visitor".
- [x] Contracts (cues, wire, audio frames, Onten, billing, ledger) + tests
- [x] Design tokens + primitives + orb + captions
- [x] Onten mock: runtime, registry, progressive compiler + tests
- [x] **The Onten boundary, written down and enforced (ADR-0019, supersedes 0003; `docs/ONTEN-BOUNDARY.md`).** Onten is mocked and stands for exactly two abilities: give it documents (`onten.learn`, one documented way in, tested by giving a fact and asking for it back), and return an AnswerContext for any question inside `ONTEN_LATENCY_BUDGET_MS = 20`. Measured on a generated 20,000-unit Zipfian corpus with 400 distinct queries: **p50 21.3 → 0.72 ms, p95 41.4 → 2.59 ms, max 78.8 → 14.9 ms** — the fix is selecting on document frequency before scoring, plus the Canonical Question Memo (CTX-MEMO-01, which the mock simply did not have; a repeat now costs 0.09 ms) and a process-shared compiled index (configure 2.3 s cold → 0 ms warm). `packages/onten/test/latency.test.ts` fails the build if p95 crosses the budget; the runtime times every call and the room reports a breach to Sentry.
- [x] Drift fixed at that boundary: pack seeding no longer mints canonical ids (it asks `resolveTopic` and calls `learn`); `TopicResolution.lessonMemoId` and the registry's dependency on Pen's lesson memo removed (a Pen concept in Onten's contract, and dead); a duplicate `titleCase` in the API deleted; and the **lesson memo moved out of `packages/onten` into `packages/session-engine`** — it caches generated lesson text, which Onten never saw and will never store, and is not CTX-MEMO-01. One drift knowingly retained and recorded with its deletion instructions: cross-language canonical-title resolution in `services/api/src/language.ts`.
- [x] LLM gateway: OpenAI Responses strict streaming, fake model, parser + tests
- [x] Session engine: room state machine, planner, turn loop, TTS pipeline + tests
- [x] API: config, identity, rooms, WS protocol, routes, ledger, seeds; smoke-tested
- [x] Voice: Fish cloud/bridge/silent; mic, VAD, segmenter, player + tests
- [x] Conductor + tests
- [x] Board package: tldraw, ink-text (Caveat outlines), strokes, code, sketch DSL, executor (122 tests)
- [x] Knowledge package: corpus builder, seeds, rights, robots, HTML→markdown (57 tests); wired into the API
- [x] App + web: screens, room session, replay; verified in Chromium with screenshots
- [x] Playwright e2e (fake providers) passes
- [x] Real-key runs: luna lesson generation, interrupt/answer path, topic-miss preparation (Swift)
- [x] Desktop host (Electron Forge) with desktop Platform adapter — **packages**: `pnpm --filter @pen/desktop package` produces `Pen Playground.app` (darwin-arm64, 313 MB), bundle id `com.penplayground.desktop`, executable `pen-playground`, the microphone usage string in Info.plist. Ad-hoc signed, which is Electron's default without an identity.
- [x] Persistence (Drizzle, PGlite in dev, Postgres-ready) behind the session index and participants
- [x] Billing: Stripe checkout/portal/webhook, plan from the participant row (needs price ids)
- [x] Replay from the ledger through the conductor
- [x] Google sign-in (accounts on the same participant row; behind GOOGLE_CLIENT_ID / VITE_GOOGLE_CLIENT_ID; desktop hidden)
- [x] MP4 download (Playwright replay + ffmpeg mux, paid plans, host only); YouTube upload dropped per round 2
- [x] LiveKit rooms audio (human-to-human voice): self-hosted server in the stack, token + mute routes, shared-mic client, participants popover, two-browser e2e (ADR-0012)
- [x] Rooms audio: TURN (LiveKit's own, UDP 3478 + relay range) — the join response hands every client the server and a credential; `e2e rooms-turn` proves a relay allocation and that ordinary browsers stay direct (ADR-0012)
- [x] Rooms audio: **TURN/TLS on 443 is live.** Hetzner floating IP `5.78.25.5` (us-west, the server's own zone) carries `turn.penplayground.com`; nginx's ten IPv4 listeners pinned to `5.78.205.172:443` and nginx *restarted* (a reload keeps its existing sockets, so the wildcard survives one); `PEN_TURN_TLS_BIND=5.78.25.5:443`; certificate via certbot with `cert-sync.sh` installed as a deploy hook. Verified from the public internet: the handshake to `turn.penplayground.com:443` presents `CN=turn.penplayground.com`, and all ten hostnames on the box returned identical status codes before and after.
- [ ] Rooms audio follow-ups: expert joins the media room as an agent (mixed track for export); guest voice in the ledger
- [ ] **Rename leftovers that are identifiers, not words.** `pen-academy` still spells
  the JWT issuer (`services/api/src/identity.ts`), the Onten policy id
  (`packages/onten/src/policy.ts`), the PostHog `app` property and the Sentry project names.
  Left alone on purpose: changing the issuer invalidates every token in the wild, the policy id
  keys compiled packs and memo entries, and the analytics names are what the history is filed
  under. Each is a migration with a cutover, not a find-and-replace. The user-visible ones are
  done — the desktop executable was the last (`pen-academy` → `pen-playground`).

- [ ] **Owner, deferred to the desktop release:** Apple Developer ID + an Apple app-specific password, and a Windows code-signing certificate. Nothing in the repo is waiting on them — `forge.config.ts` already switches on `APPLE_ID` and the makers are configured — so this is a credentials task, not an implementation one. Until then the app is ad-hoc signed and macOS will warn on first open.
- [x] Sentry projects (pen-academy-api/web/desktop)
- [x] Sentry source maps upload (web + api; release = git sha; BuildKit secret in deploy.sh)
- [x] Server-side STT relay (ws-relay to the 5090 box, Deepgram, AssemblyAI); warm-up at boot
- [x] Listen test with Fish Audio (s2.1-pro-free)
- [x] Pace: host-set, synchronized (voice + board + captions), presets, persisted; teacher-rhythm default (ADR-0010; listen test `pnpm --filter @pen/api listen:pace`)
- [x] Pace re-take: a pace change re-cuts every sentence banked behind the one being heard (`SayPipeline.retake`, `say_take` with `reason: 'pace'`), and the conductor swaps the stale bank at the next sentence boundary
- [ ] Pace follow-ups: a spoken "faster" command; scrubber on the replay screen
- [x] Observability: per-session stage timings, costs by component, interactions, errors → ledger + PostHog + Sentry; Insights tab; pull-back verified (ADR-0011)
- [x] Reuse statistics: `reused`/`savedUsd` on stages, `SessionTelemetry.reuse`, `canonicalId`, incremental lesson memo, `/api/stats/reuse`, `telemetry:pull --topic|--all`
- [x] Lesson voice store (ADR-0017): a lesson's audio kept beside the lesson it speaks (`<canonicalId>/<band>/<expertId>`), versioned by a hash of the sentence's text, engine, voice, speed, rate and tone — so re-writing one sentence retires exactly that sentence and nothing else. One synthesis shared between concurrent rooms, LRU under `PEN_TTS_CACHE_MB`, `reused`/`savedUsd` on the `tts` stage and a $0 cost line.
- [x] The privacy line: only the taught lesson is stored. A learner's question, the answer composed for it, a check-in verdict and honest failure lines carry no lesson mark, so the store never sees them — they are spoken fresh for every learner, and live only in that session's own ledger for observability (`packages/session-engine/test/lesson-voice-boundary.test.ts`).
- [x] The pipeline's lookahead is bounded by banked **audio** (20 s), not just by sentence count: three long sentences are a minute of speech and would overflow the client's 30 s player bank, whose rejections would stall room and learner on each other. A latent flaw with any fast provider; the store is what made it reachable.
- [x] Lesson voice store is **on by default** (`PEN_TTS_CACHE_MB=2048`). Measured with real Fish (`s2.1-pro-free`), same topic twice: 2 of 2 sentences served from the store on the second telling, byte-for-byte identical audio (610,294 bytes, 6.919 s, 58 frames, zero clock discontinuities), first audio 107,642 ms → 106 ms, and the store held only the two lesson sentences — the question and its answer were never written down. A human listen to `.pen-data/fish-listen/{cold,warm}-L0.s*.wav` is the one check still outstanding; the waveforms are identical, so it is a formality rather than a risk.
- [x] The deadlock turning it on exposed: the pipeline's 20 s audio budget is released only by "heard", and a check-in answer neither cancels the lesson nor reports anything heard — so with the budget full the answer was never synthesised and the room sat in `answering` for ever (and the between-segment ad never opened). The room now tells the pipeline the bank is gone when the learner takes the floor, which is what every client has already done. A/B on one warm store, one line differing: ad shown no→yes, progress 17→24 of 25.
- [ ] Replay scrubber (`replay_seeked` is reserved in the interaction contract)
- [x] Stripe webhook endpoint registered (sandbox we_1UGlYMRiNibGZsZpHljObkgl; `pnpm --filter @pen/api stripe:webhook`)
- [x] Export follow-ups: queued jobs resume; no anonymous participant per render; pre-mixed PCM
- [x] Fake model: completion for the knowledge outline purpose (Sentry issue) — locked by test
- [x] Dev DB: migration timestamp guard (journal `when` vs applied `created_at`, by hash)
- [x] Session thumbnails: one background `session_meta` call → SketchSpec → SVG/PNG next to the ledger; cards, session page and share OG use it (ADR-0013)
- [x] Thumbnails: the card is cached per lesson (memo scope + plan digest) — a repeat session reuses description and sketch with zero model calls and reports `reused`/`savedUsd`; `pnpm --filter @pen/api thumbnails:backfill [--limit N] [--dry-run]` fills in older sessions (ADR-0013)
- [x] Thumbnails are real pictures: one `gpt-image-1` generation per lesson from the session title (1536×1024, quality `low`, ≈ $0.0163), downscaled to the card and the og image — one call, every size. Cached per lesson so a repeat pays nothing; priced into the session ledger as `image` cost lines. The sketch DSL and its renderer are deleted (ADR-0021)
- [x] Every background card and thumbnail call bills to the HOST'S plan key, the same one the lesson ran on (`billTo`); `OPENAI_API_KEY_PLATFORM` is only for work belonging to no learner — the backfill and the probe (ADR-0021)
- [x] Video ads (ADR-0014): Google Ad Manager via IMA behind `PEN_AD_TAG_URL`; player + overlay, measurement, revenue estimate, ads.txt, e2e against the sample tag
- [x] Ads: `ad_event` lands in the session ledger (host-validated `interaction` entries; estimated revenue as an `ads` cost line → Insights + PostHog)
- [ ] **Owner, deferred:** AdSense site review and a Google Ad Manager account, then `PEN_AD_TAG_URL` and `ads.txt` (docs/ADS.md). Not needed before the desktop and macOS release; `/api/health` reports `ads:"off"` until the tag is set, and every ad path is already built and tested against Google's sample tag.
- [ ] Ads: Ad Manager reporting API replaces the eCPM estimate
- [x] Ads: non-personalised everywhere (`npa=1`, server-side) and limited ads in Europe (`ltd=1`, from the viewer's timezone) — so no CMP is needed (ADR-0018, docs/ADS.md)
- [ ] Ads: child-directed tagging (`tfcd=1`) for topics aimed at children
- [ ] **The full Playwright suite is contention-flaky, and it is no longer
      only `persian.spec.ts`.** Across four full runs on 2026-09-20 the
      failing set moved every time — once `ui-a11y`, once `ads`, once
      `ui-panel` + `ads` + `timeline:182` — and **every one of them passed
      when run alone**, usually in a third of the time it had taken to fail.
      One worker drives four server pairs through real lessons with real
      clocks; a spec that waits 8 s for something that usually takes 2 is
      fine alone and not fine behind three other lessons. The specs are not
      wrong about the product, and re-running until green is not a fix: the
      suite needs either its own API pair per group or budgets that scale
      with what else is running. Until then a full-run failure is only a
      finding once it reproduces alone.
- [ ] `e2e/persian.spec.ts` fails in a *full-suite* run and passes alone (18 s): the first Persian caption never appears within 30 s. Not caused by the lesson voice store — an untouched checkout of the same base commit produces the identical tally (22 passed, 3 skipped, 1 failed, the same spec), so it is the suite's own contention: one worker, four server pairs, and a Persian lesson that has to be planned and spoken before its first caption lands. Worth either its own budget or its own API pair.
- [ ] Ads: a local VAST fixture for CI needs the e2e page on **https** first. The API already serves one (`/api/dev/ad/vast.xml` + a 14 KB MP4, dev-only, `PEN_E2E_AD_FIXTURE=1`), and it is refused for a reason that is the browser's, not ours: the IMA SDK requests the tag from inside its own frame, that frame mirrors the page's scheme, and Chrome blocks an insecure public origin from reaching a loopback address — "the request client is not a secure context and the resource is in more-private address space `loopback`", surfacing as IMA error 1005 (FAILED_TO_REQUEST_ADS, confirmed against the SDK's own code table). Serving the ad pair's web server over https (its own `use.baseURL` on the `chrome` project, `ignoreHTTPSErrors`, and `Access-Control-Allow-Private-Network: true` on the fixture route) is the way to finish it. Changing the ad player to fetch the VAST itself and pass `adsResponse` would also work, and was deliberately not done: it makes a synchronous revenue path asynchronous for a test's benefit.
- [ ] Ads: `apps/web/e2e/ads.spec.ts` depends on Google's public sample tag returning a creative within 8 s; it fails on a slow or unlucky network. Consider a recorded VAST fixture for CI and keep the live tag as a manual check.
- [x] App shell (ADR-0015): persistent sidebar (240 px / 72 px rail / drawer), Experts screen, Topics filter, History · Learn later · Liked · Downloads · Rooms, like/save on cards and the session page, migration `0004_user_lists`, adoption on Google sign-in
- [x] Terms of Use and Privacy Policy: ported from Simurgh's structure and entity, rewritten for Pen Playground; linked from the sidebar's bottom and Home's footer
- [x] Route-level code splitting: the room, the replay, the session page (Insights) and the legal pages are their own chunks behind `Suspense` (calm skeleton, no spinner); Home stays eager, and requesting the room/replay chunk starts the board chunk with it. Entry 534 → 216 kB raw, 163 → 65 kB gzip; initial JS including shared chunks 252 → 225 kB gzip
- [ ] Replay follow-up: a sentence the recording has no (complete) audio for is skipped rather than replayed — a session ended mid-lesson therefore stops early even though the scrubber shows the full length. The durations are already known (`recordedMs` falls back to `estimateSpeechMs`); driving those sentences off the recording's clock, the way `ExportClock` does, would replay the whole board.
- [ ] Shelf follow-ups: playlists (the brief's "Playlists" row) once one saved shelf is not enough; "continue where you left off" from `session_visits`; a Rooms screen that lists rooms guests actually joined rather than every hosted session
- [ ] Language: a session-language preference in the sidebar's Settings (there is no such setting today, so the row is omitted rather than faked)
- [x] Replay never freezes on a sentence: `MediaSayPlayer` watches the element it told to play, and if its clock has not moved in 4 s (`MEDIA_STALL_TIMEOUT_MS`) it reports `PEN_MEDIA_STALLED` and times that sentence off the wall clock instead — mute, but the board, the captions and the transport keep going, and the viewer is told once. Why `ui-replay.spec.ts` failed: after a room has been opened, every `<audio>` element in that browser sits at HAVE_METADATA (a `stalled` event, no `error`, `play()` never settles), so the replay's clock stayed at 0:00 for ever. That is the open defect below; this fix is the recovery, not the cure. `positionMs` also no longer jumps back to the start of a sentence once it has been heard.
- [x] An ad that starts and then shows nothing gives the lesson its time back: a watchdog on `AD_PROGRESS` / quartiles / media `timeupdate` / the falling remaining time ends the ad 4 s after the last sign of life (`AD_RULES.progressTimeoutMs`), reported as `ad_error {code: STALLED}` through the existing ad telemetry. Root cause of `ads.spec.ts`: the policy was missing `*.2mdn.net` (the SDK's own video client script), `csi.gstatic.com` (its beacon) and `*.gvt1.com` (where the creative actually streams from), so the SDK's video client was blocked outright and the tag timed out at 8 s. With those added the creative loads and reaches `ad_started`, and then its clock never moves. Same cause as the replay stall above, proven by an A/B in one browser: the same tag on a bare page gives 29 `AD_PROGRESS` events and a clock at 7.5 s; after a room has been opened in that browser the identical run reaches `start` and stops, 0 `AD_PROGRESS`, clock 0.00. That shared cause is the open defect below. Recovering from it, rather than waiting for the conductor's 30 s ceiling, is what the spec now asserts.
- [x] Terms · Privacy · © are said once: the sidebar's footer carries them from 1024 px up (where the shell's sidebar is in the layout) and Home's own footer carries them below that, where the sidebar is a drawer. Home keeps Pricing, Your sessions and Privacy choices at every width (`shell.spec.ts`, three widths)
- [x] The UI e2e pair was missing `PEN_MAX_SESSIONS_PER_IP`: the hardening merge added the per-IP live-session cap and raised it for the two pairs that existed on that branch, not the UI pair added later. The ui-* specs leave live rooms behind, so from the sixth one on the API answered `RATE_LIMITED` and the board never appeared (reproduced against the pair's own env: sessions 1-5 → 201, 6-7 → 429)
- [x] Turning analytics off while posthog-js is still being fetched now really stops it: lazy loading opened a window in which the opt-out had nothing to act on and the import initialised the SDK afterwards anyway (`packages/app/test/analytics-privacy.test.ts` fails without the guard)
- [x] Audio-service note: the room asked for a new `AudioContext` **56 times** in one lesson when construction failed, instead of giving up once and telling the learner. Fixed — the player asks once, reports once, and retries only on the learner's next tap (`prime()` clears the flag); the room raises the same honest "tap to hear" state it already had for autoplay. Pinned by `packages/voice/test/player.test.ts` → "asks once, says so once, and tries again only when the learner taps".
- [ ] `apps/web/e2e/rooms.spec.ts` fails in this environment: a LiveKit container answers HTTP on :7880 but the browser's WebSocket never connects, and the spec's reachability probe (HTTP) does not catch it. Fails identically before ADR-0015.
- [x] SEO and share basics: robots.txt, a dynamic sitemap from the API (public sessions + static pages, cached 1 h), canonical URLs and per-screen description/title, `LearningResource` JSON-LD on `/s/:id`, complete Twitter cards
- [x] A 404 screen that starts a session, and an error boundary that reports to the Monitor seam and shows the reference id
- [x] Session language (migration `0005_session_language`): `<html lang>` follows the session, captions/notes/recap/transcript read right to left for Persian, Arabic and Hebrew, board text is drawn as one shaped run, dates via `Intl`; the lesson plan is written in the session's language and the lesson memo is keyed by it (`e2e persian`)
- [ ] Language follow-ups: translate the chrome itself (headings, buttons) for RTL locales, and mirror the room layout (`dir` on the shell) once the board's camera and note slots are direction-aware
- [x] CI on GitHub Actions: `pnpm verify` (ffmpeg + Chromium, no skipped integration tests), e2e with fake providers, both images built for linux/amd64; traces uploaded on failure; badge in README
- [x] Backups: nightly `pg_dump` + `/data` tarball sidecar (compose profile `backup`, 14 days, checksums, optional rclone off-host), `deploy/backup/restore.sh`; restore proven against a throwaway Postgres
- [x] Alerting: Sentry workflows (new issue, error-rate spike) + Cron monitor `pen-api-heartbeat` created via API (`pnpm --filter @pen/api sentry:alerts`); API checks in every 5 min behind `SENTRY_CRON_MONITOR_SLUG`
- [x] `/api/ready` (DB, data dir, providers) used by the compose healthcheck and the edge; `deploy/uptime.md` for the external check
- [x] Load check `pnpm --filter @pen/api load --sessions N`: 50 concurrent sessions hold first-audio p95 ≈ 320 ms; thumbnail rasterising moved off the event loop (health-ping p95 160 → 7 ms)
- [x] `docs/RUNBOOK.md`: deploy/rollback, secrets rotation, scaling, incidents, backup/restore, certificates, LiveKit, ads, Google consent screen
- [ ] Ops follow-ups: PostHog dashboard needs `dashboard:write` + `insight:write` on the personal key (queries validated, `posthog:dashboard --print` meanwhile); owner creates the UptimeRobot check (`deploy/uptime.md`); a second Sentry Cron monitor needs a paid seat; `ExportJobs.jobs`/`fingerprints` grow per exported session (bounded in practice, no eviction)

## Production hardening (2026-09-17)

- [x] Plan limits enforced server-side: 3 sessions per **UTC** day on free, session length by plan (20/45/60 min), seats by plan; `GET /api/me/usage` and a friendly gate on Home (ADR-0016)
- [x] Daily spend circuit breaker from the ledger's own cost lines, rebuilt on boot, Sentry warning at 80 % (ADR-0016)
- [x] Abuse limits: per-socket message budgets, bad-frame close, transcript ceiling, 64 KB bodies, per-IP live-session cap
- [x] Security headers (HSTS behind TLS only, `microphone=(self)`, `DENY`, `no-referrer`) and CORS limited to the configured origins
- [x] Content-Security-Policy generated from one source (`apps/web/csp.ts`), served by the web container and by the dev server, verified by a Playwright run that records every origin a session touches. Re-derived after the app shell and the route split: `csp.spec.ts` now walks Home, Experts, a shelf, the legal pages, a live room, the saved session page and a replay (zero violations), and the ad path added `*.2mdn.net`, `csi.gstatic.com` and `*.gvt1.com`; dev additionally allows `http://imasdk.googleapis.com` in `frame-src` because the SDK frames its own origin on the page's scheme
- [x] Data rights: `DELETE /api/me`, `DELETE /api/sessions/:id`, `PATCH /api/sessions/:id` visibility, `GET /api/me/export`, with the controls in the account sheet and the session page
- [x] Privacy without a banner: cookieless PostHog, non-personalised ads, "Privacy choices" with a server-honoured analytics switch (`0006_analytics_opt_out`) (ADR-0018)
- [ ] Spend breaker is per process; a second node needs a shared counter (Redis behind `SpendBreaker`)
- [ ] `DELETE /api/me` leaves the Stripe customer in place on purpose; decide whether deletion should also cancel a live subscription
- [x] **Media wedge after a lesson: test-environment only, not user-facing.** Playwright's bundled
      Chromium stops rendering media (`<audio>` stays at HAVE_METADATA, `play()` never settles) for
      the rest of the browser once a room has been opened; the same build of real Chrome
      (`channel: 'chrome'`, Chrome/153) is unaffected across repeated runs, including on a new page.
      Bisected and eliminated: tldraw, microphone permission, the playback/capture AudioContexts and
      their combination, speech recognition alone, 25 start/stop recognition cycles, and Chrome's
      on-device recognition (`processLocally`). It only appears when the browser recognizer path runs
      inside the room in that Chromium. The ad and replay stall watchdogs stay as defence in depth;
      prefer `channel: 'chrome'` for any spec that must play media after a lesson.
- [ ] `export.integration.test.ts` fails intermittently only inside the full API suite (passed alone
      twice, failed twice in-suite, passed in-suite on the third run, 2026-09-18). It drives a real
      Chromium plus ffmpeg while 24 other files run, so the likely cause is contention rather than
      logic — but that is a hypothesis, not a diagnosis. Next step: run it with `--no-file-parallelism`
      and with the renderer's timings logged, and if contention is confirmed, give it its own project
      rather than a longer timeout.

## First audio on a prepared topic (2026-09-18)

Measured with real keys (`PEN_LLM_PROVIDER=openai`, `PEN_TTS_PROVIDER=fish-cloud`,
`s2.1-pro-free`), the seeded Transformers pack, a cleared data directory per run,
three cold sessions before and three after. Before: **7947 / 5778 / 5396 ms** to
first audio. After: **4924 / 4036 / 4683 ms**.

- [x] The expert starts composing segment 1 while the planner is still writing
      (ADR-0019). `streamPlan` hands back the title, the promise and segment 1 as
      soon as the model has written them — at 38–54 % of the plan call — and the
      segment-1 call goes out against them. Nothing is broadcast until the plan is
      whole, so the learner can never hear a sentence the final plan contradicts.
      The lesson call's first token is now entirely hidden: the first cue is
      emitted 1–3 ms after the plan lands (it was 1.0–1.6 s after, before).
- [x] The catalogue card no longer competes with the first sentence. It started at
      t = 4813 / 3919 / 3541 ms, alongside the lesson call on the same connection;
      it now starts at t = 4918 / 4029 / 4677 ms, 1 ms after the first audio frame
      (`SessionRoom.firstAudio`).
- [x] Fish free tier measured, twice, ten sentences each: first chunk min 392 ms,
      p50 439–611 ms, max 716 ms on an idle machine; 456–1773 ms under real session
      load. **Sentence length does not move it** (short opening lines 604 / 448 ms
      mean, lesson-length 515 / 467 ms), so the prompts were left alone rather than
      asking the expert for a short opening line that would have bought nothing.
      `SayPipeline` was already free of batching: a sentence is synthesised the
      instant the parser emits it.
- [x] `pnpm --filter @pen/api packs:prewarm` teaches every seeded pack once over the
      ordinary room protocol, so the memo and the lesson voice store are warm before
      the first real learner. Measured: 114 sentences in 305 s, after which a
      first-ever learner reached first audio in **108 ms** with plan, segments, card
      and voice all reused. Warm sessions on the new code: 131 / 120 / 120 ms.
- [ ] The honest floor for a *cold* prepared topic is now the plan call plus one
      voice first-chunk — 4.0–4.9 s here, almost all of it the plan call — and no
      further pipeline work will close it: there is nothing left to overlap. The
      levers left are a smaller `PEN_LLM_OUTLINE_MODEL` for the plan (it is the
      session model today), `PEN_LLM_SERVICE_TIER=priority`, paid Fish capacity, or
      arriving warm. `complete()` also still sends neither `verbosity: 'low'` nor
      `service_tier`, while `streamEvents()` sends both — untested, deliberately left.
- [x] `base-path.spec.ts` was running in the main Playwright config despite the
      top-level `testIgnore` naming it: a project that declares its own `testIgnore`
      **replaces** the top-level one, and the chromium project does. The spec (and
      its exclusion) arrived with the base-path merge, after the chromium/chrome
      split was already in place, so the exclusion has never taken effect at this
      commit — the spec failed on the prefix it cannot have and left a lesson
      running on the shared API, exactly as the config's comment warns, and
      `csp.spec.ts` failed behind it. The chromium project now carries the pattern
      too (`playwright test --list`: 27 tests in 13 files before, 26 in 12 after,
      which is the 26 the last recorded control run had).
- [x] The UI, rooms and preview e2e pairs are addressed by *URL*, not by port
      (`PEN_E2E_UI_WEB`, `PEN_E2E_ROOMS_WEB`, `PEN_E2E_PREVIEW` in the specs;
      `…_PORT` in the config). Moving the pairs with only the `…_PORT` variables
      leaves every `ui-*` spec hitting the default port and failing in ~400 ms.
      Written down in `playwright.config.ts` next to the ports.
- [x] **A visit keeps the client address and the raw `User-Agent`, on a
      thirty-day clock (ADR-0028, amending ADR-0027).** The owner asked for the
      IP address and everything else a browser gives up without a permission
      prompt, and for precise location to stay out. `site_visits` gains
      `ip_address`, `user_agent`, `screen_width/height`,
      `viewport_width/height` and `device_pixel_ratio` (migration
      `0010_visit_identifiers`). The address is resolved by `clientAddress` —
      the function `clientKey` is now built on, so the per-IP session cap
      (`PEN_MAX_SESSIONS_PER_IP`), the beacon limiter and the stored row can
      never disagree about which header names a client — then validated with
      `node:net`'s `isIP` and normalised to one spelling per machine (port,
      brackets and zone index stripped, IPv6 lowercased, `::ffff:` mapped to
      the IPv4 it is). Country is unchanged and still comes from the edge or
      the browser's clock with `geo_source` saying which: no geo database was
      added, so an address yields no place, and region, city and coordinates
      stay out. `PEN_VISIT_IDENTIFIER_DAYS` (default 30, the dashboard's own
      default window) clears both identifiers from older rows on an hourly
      pass inside the existing one-minute sweeper, leaving every derived
      column and every count standing; `0` stores neither and erases what is
      there. Not a runtime setting (`privacy`, beside `PEN_VISIT_STATS`).
      The privacy policy is unchanged by instruction; `docs/STATISTICS.md`
      records what is stored, for how long, and which published sentence does
      and does not cover it.

## The identity window, and words on the thumbnails (2026-09-19)

- [x] **Identity is issued once and waited for (ADR-0030).** Three bugs in the
      same window — the tens of milliseconds between the shell mounting and
      the anonymous bearer arriving — and all three the same shape: a field
      read, an `await`, the field read again. `ensureParticipant()` was not
      single-flight, so two callers each minted a participant and the second
      write orphaned the first; any authed call made in the window went out
      with no `authorization` header; and `Home.start` papered over that by
      checking `participant`, saying "Connecting to Pen Playground…" and
      **dropping the click**. The fix is one in-flight promise in `ApiClient`
      that every call needing a bearer joins (`request`'s `identity` mode,
      `'required'` by default and *ensure* rather than merely wait, so the
      call after a failed mint retries instead of going out bare). `Home`
      stopped checking anything and guards re-entry with a ref, because
      `starting` is a render and a second click in the same frame reads the
      stale value. `packages/app/test/identity-race.test.ts` (7) and
      `start-before-identity.test.tsx` (2); all nine fail on an unchanged
      checkout, 227 pass in `@pen/app`.
- [x] **Thumbnails carry a headline (ADR-0029).** The owner: "make sure the
      images that are generated has some titles or text on them, not just a
      pure image of a place." ADR-0021 had ended the prompt with "no text"
      because a model *choosing* its own lettering invents it; handed an
      exact short string it sets type instead. `headline` rides on the copy
      call that was already being made, so the cost per session does not
      move: still one text call and one generation. Measured against the real
      endpoint, quality `low`, 11 generations across 9 titles — every
      headline spelled correctly. Two defects found and fixed in the
      measuring: one generation set the quoted *title* instead of the
      headline (the title is now unquoted context, `about <title>`), and two
      chose a subject that is a surface made to be read, whose background
      lettered itself (the exclusion list gains `card`/`sticky note`/etc and,
      what actually worked, a positive redirect to the tool or the hands).
      Non-Latin scripts get no text on purpose: `gpt-image-1` renders Arabic
      script as decorative marks, which is worse than a clean photograph.
- [ ] Older sessions keep the pictures they have: `headline` defaults to `''`
      so their `meta.json` and cache entries parse unchanged, and
      `thumbnails:backfill` re-encodes rather than re-generates. Giving the
      existing library text means paying for a generation each — the owner's
      call, and not free like the re-encode was.
- [x] **One lesson, one card — and the duplicates already stored are gone
      (ADR-0031).** The owner: *"why duplicate topics are stored and
      generated? this is very bad if true. because it means we spent more
      tokens, time and storage"*, then: delete them. Measured first, and the
      premise is half right. **The generation is not duplicated**: the lesson
      memo held one entry reused 16 times, the card/picture cache one entry
      per scope, and per-session cost on one topic fell $0.002106 → $0.001221
      → $0.000302 → ~$0.00009 — a repeat costs about a twentieth of the
      first. All 25 recordings on this machine had cost $0.009355 in total.
      **The catalogue was duplicated**: `listPublic` returned every public
      ended row and Home drew one card each — 20 cards, 14 of them the same
      lesson. Fixed at the query: one card per lesson scope
      (`canonicalId|band|expertId|language`, the same key the memo, card and
      picture share), best telling representing it; "My sessions", history
      and the shelves stay uncollapsed on purpose. `sessions:dedupe` erases
      the rest, dry by default (`--apply` does it, `--include-accounts` for a
      signed-in host's session), repairing a missing `canonical_id` from the
      session's own ledger or the registry first. Nothing is dropped on the
      floor: saves, likes, history and site visits move to the survivor, its
      views absorb theirs, and `session_redirects` makes an old share link
      open the lesson that was kept rather than 404. `sessions.segments` is
      *not* the completeness measure — it is the plan's length and identical
      for every telling — so the rule ranks on recap points then duration;
      the script also prefers a telling whose recording is still on disk.
      Found and fixed on the way: `session_saves`, `session_likes` and
      `session_visits` had **no deleter at all**, and
      `site_visits.last_session_id` was never nulled, so every session
      deletion since ADR-0015 has left invisible permanent rows behind.
      Measured on this machine: 5 rows repaired, 15 tellings erased, 15
      redirects, 10 shelf rows moved, 0 failures; sessions 27 → 12, cards
      20 → 4, recordings 18 MB → 14 MB, orphaned visits 0. Tests:
      `packages/db/test/duplicates.test.ts` (15) and
      `services/api/test/dedupe.test.ts` (3); the catalogue and deletion
      cases fail on an unchanged checkout.
- [ ] The recap is the one piece of model work still generated per session on
      a memoised lesson (~$0.0002 a time; 0 of 10 reused on disk). It
      summarises a script that was itself replayed, so it is probably
      memoisable under the same scope — a decision, not a bug.

## Races, and the things that only look like races (2026-09-19)

An audit of the whole codebase for interleaving across `await`, swallowed
rejections, lifecycle leaks and bad conversions. Eight findings were fixed in
the audit itself (see the commit); these four are the ones taken on
afterwards, each with a test that fails on an unchanged checkout.

- [x] **Both ceilings on `POST /api/sessions` were walk-throughs
      (`services/api/src/admissions.ts`).** The plan's daily allowance and
      `PEN_MAX_SESSIONS_PER_IP` were both check-then-act across
      `rooms.create()` — the intake model call, a second and a half. Measured
      before the fix: **eight concurrent POSTs on a three-a-day free plan
      returned eight 201s**, and six concurrent on a cap of two returned six.
      Both ceilings exist to bound real provider spend. A place is now taken
      in the same tick as the check and given back in a `finally` after the
      row is written, so the eighth request counts the seven ahead of it. The
      IP check also moved *outside* `if (hosted)`: on the first burst from a
      new address there is no set to count, which was the easiest moment to
      walk through. In-process, like `SpendBreaker` beside it — a second node
      needs a shared counter, and that caveat is the one already recorded for
      spend above.
- [x] **A failed cache write ended writing, for the life of the process
      (`services/api/src/write-queue.ts`).** `this.writing =
      this.writing.then(work)` in both file caches: after one rejection the
      chain is permanently rejected, every later `work` never runs, and every
      later caller gets the *original* error. One transient `ENOSPC` and the
      card cache and the picture cache are off — silently, because nothing
      re-reads a cache it just failed to write. The symptom is every session
      paying ~$0.016 again for a picture already bought. The queue keeps the
      ordering and drops the poison; proved on a real directory chmod'd
      read-only and then writable again.
- [x] **A frame that was not JSON bypassed the bad-frame kill switch**
      (`app.ts`). `badFrames` and `close(4002)` lived only in the branch for
      a frame that *parsed* and failed the schema; `JSON.parse` threw past it
      into the outer catch, which files a Sentry issue and answers
      `INTERNAL`. One authenticated socket sending `{` was one issue per
      frame, for as long as it kept sending, and nothing ever closed it.
- [x] **`SessionRoom.end()`'s new claim cannot poison itself.** Two callers
      reach it by `void this.end()`, where a rejection is an unhandled one,
      and a claim holding a rejected promise would hand that failure to every
      later caller including the registry's cleanup. The failure is reported
      and the claim stands: a room that failed to finish ending is still a
      room that must not pay for a second recap.
- [x] **The Statistics section of the operations console is real** (ADR-0026's
      nav entry no longer says "Soon"). Thirteen reporting endpoints, seven
      pages, cut by the question being asked rather than by the route that
      answers it: Overview, Money (`cost` + `plans`), Sessions (+ one
      lesson's own page, where "reused fourteen times, and here are the
      searches" is answered), Pipeline (`stages` + `abandonment`), People
      (`users` + `retention`), Visits, Audience (`geography` + `devices` +
      `clock`). One date range for the whole section, held in the URL as a
      preset so a reload keeps it and a link carries it; its default
      reproduces `DEFAULT_WINDOW_MS` and `range.test.ts` asserts that against
      `routes.ts` itself rather than against a copied number. No chart
      library: the geometry is a hundred pure lines in
      `apps/admin/src/charts/geometry.ts`, drawn in the brand at varying
      weight because every other hue in the design system already means
      something. `/geography`'s note is printed verbatim and the region and
      city columns are kept and left visibly empty. 134 unit tests, 12
      Playwright tests, and 40 review pictures in `.pen-data/admin-review/`
      (every page, light and dark, populated and empty, plus tablet and
      phone). **Not done, and outside the fence:** there is no window total
      for replays, shares, downloads or exports, because that needs one more
      aggregate in `packages/db/src/reports.ts`; the exact SQL is written
      down in `docs/STATISTICS.md`, "What the console cannot show yet".
- [x] **Shutdown stopped losing the deploy's lessons.** `server.close()` never
      fired while a room socket was open and nothing closed them, so the 3 s
      `process.exit(0)` was the *normal* path: `db.close()` and
      `analytics.shutdown()` were dead code, live rooms kept `endedAt: null`
      for ever (out of the catalogue, out of every report, and in the
      learner's own list as a lesson that never finished), and
      `deriver.close()` **cleared** the statistics queue, binning up to
      `STATS_SETTLE_MS` of finished sessions. Now: stop taking work, end the
      lessons (`rooms.endAll('shutdown')`, which writes the rows and queues
      them), `deriver.flush()` (the settle delays included, which `drain()`
      deliberately skips), `closeAllConnections()` then `server.close()`,
      then the database — each step failing without stopping the next, under
      one `PEN_SHUTDOWN_GRACE_MS` ceiling of 15 s. `deploy/docker-compose.yml`
      gains `stop_grace_period: 25s`, because Docker's default 10 s would
      SIGKILL the process in the middle of the writes the graceful path
      exists to do.
- [x] **A hot microphone (`RoomAudio.publishIfReady`).** `published = true`
      was set before awaiting `port.publish()` — correct, it is what stops a
      second clone — and by itself a live mic. Publishing is a
      renegotiation; a learner who turns the mic off inside that window runs
      `detachMicrophone`, which sees `published === true`, sets it false and
      unpublishes nothing, because nothing is there yet. The publish then
      lands: a live clone in the room, `published === false` beside it, the
      UI saying the microphone is off. An epoch, bumped by anything that
      supersedes a publish, is read back across the await; the clone is
      stopped on every path that does not keep it, because a clone left
      running holds the browser's recording indicator on by itself.
- [ ] `LeaveReason` has no `interrupted`: a lesson the process shut down
      under falls through to `left_mid_segment`, which says the learner left
      when we did. One enum member in `packages/contracts/src/stats.ts` plus
      a branch in `derive.ts` — deliberately not done while the statistics
      pages were being written against the current set.
- [x] **Stripe webhooks apply plan changes in order.** `setPlan` was an
      unconditional UPDATE, and Stripe delivers at least once, in no order,
      retrying a failed delivery for days — so a `subscription.updated`
      landing after the `subscription.deleted` that superseded it **restored
      a cancelled subscriber's entitlements**, permanently: the row
      afterwards looks like an ordinary paying customer and no later event is
      coming. `planSince` is Stripe's `event.created` and is now the guard as
      well as the record. A tie (whole seconds, so two events in one second
      are simultaneous as far as anything here can tell) is decided by which
      mistake is recoverable: **a cancellation wins.** Refusing one would
      leave a cancelled subscriber entitled for ever; refusing an upgrade
      costs minutes. The ledger is still written either way — an event that
      arrived out of order still happened — and `billing.subscription` now
      reports `applied`, whose false is the interesting one.
- [x] **`WS_LIMITS` covers the whole protocol.** It had buckets for the
      chatty families and none for the expensive ones: `auth` verifies a JWT,
      `join` reads the session row, `progress` walks every lesson sentence
      between reports, `utterance_start`/`end` open and close a **paid**
      recognition — and upstream audio, the binary branch, had no ceiling at
      all and is the one that streams. `ws-limits.test.ts` asserts the table
      covers every `ClientMessage` kind, so a new message with no bucket
      fails a test rather than shipping unlimited.
- [x] **Room-audio failures reach Sentry.** Every failure `RoomAudio`
      reports — the media token, the connection, publish, unpublish, playback,
      giving up after five attempts — is a learner whose voice or hearing in
      the room has stopped, and every one of them went to `console.warn` and
      nowhere else, while the playback and microphone paths beside it have
      always reported properly. `errorCodeFor` shapes the code both paths use
      and is idempotent, because a code that changes shape splits one Sentry
      issue into two and makes the older one look resolved.
- [x] **`LeaveReason` gained `interrupted`.** A lesson the process shut down
      under read as `left_mid_segment` — our own releases inside the drop-off
      curve the product is judged by. It ranks above every `left_*` answer,
      because the learner did not leave: we stopped.

## The floor in a room (2026-09-23, ADR-0037)

- [x] **Guests raise a hand; the expert takes them in order at a sentence
      boundary, by name.** `hand` on the wire, `RoomState.hands` / `invited`,
      the lesson held after the sentence at the speaker (a pace re-take with
      no newer take), the invitation on the `floor` thread (never the lesson
      voice store), the floor on the invitation being heard, an 8 s wait
      before the expert lets a silent hand go by name. Withdrawn, lowered,
      left, removed, host-interrupted, during a check-in, during a discussion:
      each has a test in `packages/session-engine/test/hands.test.ts`.
- [x] **A guest without the floor is never heard.** The conductor and the
      room both drop their speech; a guest's recogniser runs only while they
      hold the floor.
- [x] **The host's discussion** (`control: discuss`): `LiveMode.discussing`,
      lesson held, expert dimmed and waiting, nobody heard, hands queue,
      `resume` brings it back. **Remove** (`remove_participant`): seat
      closed with `REMOVED`, no way back in.
- [ ] A two-browser e2e of a real hand (the rooms pair needs LiveKit, which
      does not run in this environment — `rooms.spec.ts` is recorded as
      failing here already). The panel review pictures carry a synthetic
      queue instead.

## Replay, recordings and the flags (2026-09-23)

- [x] **A recording is its host's alone (ADR-0035).** `GET /api/sessions/:id/ledger`
      and `/audio/:file` served the whole ledger — the learner's verbatim
      `caption`s, the `note` questions, every answer — to anyone with the id,
      private sessions included; the saved page listed the notes to every
      visitor. Now: the host by bearer or by the render token, 401 to nobody,
      403 to everyone else, `FEATURE_OFF` when `recording_playback` is off.
      The record stays public with the host stripped. Tests:
      `features.test.ts`, `anonymise.test.ts`, `dedupe.test.ts`.
- [x] **"Replay" is a fresh live session of your own.** `POST /api/sessions`
      takes `{ replayOf }`; the saved page, every shelf row and the refused
      replay screen start the lesson again with the same expert, band and
      language, reusing the memo and the voice store. The host's playback is
      "Watch my recording". The e2e that clicked *Replay* to reach
      `/replay/:id` clicks that instead (`base-path.spec.ts`).
- [x] **The recording plays in the order it was heard.** By cue `seq` an
      answer came after the whole segment it interrupted; `recordingOrder`
      (contracts) orders by the audio's clock, last take of each sentence,
      and the replay and the export plan both use it. The learner's words
      are shown as the caption that opened each turn.
      `packages/contracts/test/recording-order.test.ts`.
- [x] **Two downloads.** `?interactions=1` (the session as lived) and
      `?interactions=0` (the lesson alone, every turn out) are two jobs and
      two files (`export-lesson.mp4`); the status names its `variant`, the
      saved page offers the choice, the Downloads shelf lists the newest.
- [x] **Feature flags by plan and platform (ADR-0036).** `FeatureRule`
      (default, per plan, per platform — AND when both — per cell) in
      contracts with the compiled-in rules; `feature_flags_state` /
      `_audits` (migration `0014_feature_flags`); `FeatureStore` (polled,
      last known good on disk) and `FeatureFlagsService`;
      `/api/admin/features` (+ history, rollback), `/api/me/features`; the
      `x-pen-platform` header from the app's `Platform.id`; the console's
      Features page (a matrix per feature, click to cycle, save with a
      reason, history, restore). A room is built with its flags and keeps
      them (`RoomState.features` for the chat, reactions and captions).
- [x] **Free learners no longer trigger topic preparation.** `RoomRegistry.create`
      throws `PreparationRefused` on a miss when `prepare_new_topics` is off
      (compiled-in: off; Standard and Professional on) before a row, an ad or
      a room exists; the route answers `402 PREPARATION_REQUIRED` with the way
      to Pricing and the lessons that are ready, and Home shows them under
      the box. Tests that start sessions for free hosts on unprepared topics
      say so with `flags: PREPARE_FOR_EVERYONE` (`services/api/test/flags.ts`).
- [x] Every flag is read on the server: `ads` (`AdEconomics.policyFor` now
      takes the resolved features), `rooms` (join, LiveKit token,
      participant audio), `session_download`, `recording_playback`,
      `quick_start`, `chat` / `reactions` / `captions` (the room refuses
      silently, the client hides), `google_sign_in` / `email_sign_in` (503
      per platform).
- [x] **Rooms are recordings, not replays** (ADR-0035 amendment). A session
      with guests is recorded whole for its host alone; the bar shows a
      *Recording* mark and a guest is told once on joining. `replayOf` a room
      is `409 NOT_REPLAYABLE`, its page offers no Replay, and rooms are not
      catalogue cards. `guests` rides on served records from `session_visits`.
- [x] **Nothing about the learner on the board.** The owner: "they won't
      write the name of the person who asked the question on the board."
      Already true of the board (no note is drawn since ADR-0032); the
      product doc said otherwise and now does not. In a room, words spoken to
      the expert land in the chat under the speaker's name, marked "to
      <expert>", in their own run (`ChatLine.kind = 'question'`); solo shows
      nothing. `packages/app/test/chat.test.ts`.
- [x] `shared_replays` removed from `PLAN_ENTITLEMENTS`, the Rooms shelf and
      Pricing: a room's recording is the host's to watch or export.
- [x] Resume keeps restarting the cut sentence, by the owner's ruling;
      `docs/PRODUCT.md` says so instead of flagging it.
- [x] A question Onten has nothing on (`missing`) is answered by one warm
      redirect from `outOfScope` with no model call, and recorded as
      `question_out_of_scope` beside the learner's words in the recording.
      `packages/session-engine/test/room.test.ts`.
- [x] `partial`, `conflict` and `stale` each get their own instruction in the
      answer prompt (`evidenceGuidance`, prompts.ts): what to say with
      confidence, what to say plainly is not there, and never a guess to
      fill a gap. `packages/session-engine/test/prompts.test.ts`.

## The room is a room again (2026-09-20)

- [x] **Chat is between the people in the room; the expert is not in it
      (ADR-0032).** The panel held every sentence of the lesson as a chat
      message, and typing into it interrupted the lesson. The owner: *"the
      chat is only between participants and the expert never sees that and
      never care and this should not interrupt the session."* `ClientChat` /
      `ServerChat` are modelled on `reaction` — the one message this room
      already had whose contract says nothing else in the session reads it —
      and `SessionRoom.chat()` broadcasts, rate-limits, refuses during an ad,
      and does nothing else. The rule lives in the **room**, not the panel: a
      UI rule is one refactor from being wrong. `chat.test.ts` is written as
      absences (no floor, no mode change, no cue, no model call) because the
      absences are the feature, and the ledger keeps a character count and
      never the words.
- [x] **Asking the expert is speaking.** Typed questions are gone; the
      composer sends chat. `timeline.spec.ts` was rewritten to ask **by
      voice** through a fake `SpeechRecognition` installed before navigation,
      so the pause-answer-resume behaviour is still proved rather than
      deleted.
- [x] **Captions carry no name and are off until asked for.** *"a real expert
      will not write his name and transcript on the board."* `Caption` lost
      its speaker; `captionsOn` defaults to false; the CC control is the only
      way they appear. `--color-caption-expert` / `-learner` went with them.
- [x] **A solo session has no panel (ADR-0033).** One learner and one expert
      is the ordinary session, and for it the panel was a roster of two and a
      chat nobody else could read. No panel at any width, no panel toggle, no
      reaction control — and one small tile over the board carrying the three
      things the roster carried that still mean something alone: the expert
      is here, what they are doing, and the browser holding their voice.
- [x] **The roster and the avatars rebuilt as meeting-app tiles.** Names in
      the tile rather than on a floating pill, `You` unbracketed, two-letter
      initials that count graphemes, and eight avatar colours generated by
      the same M3 machinery as the brand (initials at 5.16–5.21:1 on every
      one) in place of an arbitrary `oklch(0.55 0.11 h)`.
- [x] **One person, one colour.** `AppHeader` hashed a participant id with
      `% 360` per step while the room used `>>> 0` then `% 360`; for most ids
      those disagree, so the same person was one colour on their account chip
      and another on their tile. `avatarHue` in contracts is now the only
      one, with a test that measures how far the pair diverged.
- [x] **`ui-perf`'s room budget was measuring nothing.** `decodedBodySize` is
      0 for anything Chrome serves from its memory cache, so the "cold"
      reload reported 1,500 bytes across seven script requests. It passed
      only while the page was slow enough to revalidate — a budget that gets
      easier to meet the faster the page gets. The cache is cleared over CDP
      first; the room now measures 2.74 MB.
