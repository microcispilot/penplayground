# Todo

- [x] Contracts (cues, wire, audio frames, Onten, billing, ledger) + tests
- [x] Design tokens + primitives + orb + captions
- [x] Onten mock: runtime, registry, progressive compiler, lesson memo + tests
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
- [x] Desktop host (Electron Forge) with desktop Platform adapter (typechecks; not yet packaged)
- [x] Persistence (Drizzle, PGlite in dev, Postgres-ready) behind the session index and participants
- [x] Billing: Stripe checkout/portal/webhook, plan from the participant row (needs price ids)
- [x] Replay from the ledger through the conductor
- [x] Google sign-in (accounts on the same participant row; behind GOOGLE_CLIENT_ID / VITE_GOOGLE_CLIENT_ID; desktop hidden)
- [x] MP4 download (Playwright replay + ffmpeg mux, paid plans, host only); YouTube upload dropped per round 2
- [x] LiveKit rooms audio (human-to-human voice): self-hosted server in the stack, token + mute routes, shared-mic client, participants popover, two-browser e2e (ADR-0012)
- [x] Rooms audio: TURN (LiveKit's own, UDP 3478 + relay range) — the join response hands every client the server and a credential; `e2e rooms-turn` proves a relay allocation and that ordinary browsers stay direct (ADR-0012)
- [ ] Rooms audio follow-ups: TURN/TLS on 443 (needs a second public address — LiveKit advertises `turns:<domain>:443` regardless of `tls_port`; steps in docs/DEPLOY.md); expert joins the media room as an agent (mixed track for export); guest voice in the ledger
- [ ] Desktop: package and sign (needs Apple ID / Windows cert)
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
- [x] Video ads (ADR-0014): Google Ad Manager via IMA behind `PEN_AD_TAG_URL`; player + overlay, measurement, revenue estimate, ads.txt, e2e against the sample tag
- [x] Ads: `ad_event` lands in the session ledger (host-validated `interaction` entries; estimated revenue as an `ads` cost line → Insights + PostHog)
- [ ] Ads: owner creates AdSense + Ad Manager, sets `PEN_AD_TAG_URL`, fills `ads.txt` (docs/ADS.md)
- [ ] Ads: Ad Manager reporting API replaces the eCPM estimate
- [x] Ads: non-personalised everywhere (`npa=1`, server-side) and limited ads in Europe (`ltd=1`, from the viewer's timezone) — so no CMP is needed (ADR-0018, docs/ADS.md)
- [ ] Ads: child-directed tagging (`tfcd=1`) for topics aimed at children
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
- [ ] Audio-service note (superseded, kept for the record): while chasing it, the room asks for a new `AudioContext` **56 times** in one lesson when construction fails, instead of giving up once and telling the learner. Worth a look on its own — a retry storm behind a silent failure is how "no sound" becomes unexplainable.
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
