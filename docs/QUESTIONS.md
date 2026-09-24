# Questions and answers

Round 1 (2026-09-16) is answered and applied; each item records what was done.
Round 2 lists what is still needed from you.

## Round 1 — applied

1. **Server.** Hetzner, reached over Tailscale: `prod-db-01` (Simurgh API,
   Postgres, Redis) and `prod-app-01` (Simurgh web/admin behind nginx +
   certbot). Pen Academy deploys to `prod-app-01` as its own containers
   (`deploy/`, `docs/DEPLOY.md`). Nothing runs on the 5090 box.
2. **Fish Audio.** Key in `.env`. `s2.1-pro` returns 402 (no API credit yet), so
   development uses `s2.1-pro-free` (free until 2026-11-30). First audio chunk
   arrives in ~150–250 ms; a sample is at `.pen-data/samples/sarah-s2.1-pro-free.wav`.
3. **Voices.** 132 Fish *official* voices (no celebrity clones, no character
   voices) are curated in `services/api/data/experts/voices.fish.json` (and `voices.cartesia.json` for Cartesia; ADR-0048). Every
   persona has an assigned voice **per language** stored on the persona itself
   (`voices` in `catalog.json`, written once by `pnpm --filter @pen/api
   voices:assign`); it never changes unless re-assigned. English spreads 105
   personas over 25 voices (at most 10 per voice), same gender.
4. **tldraw.** Key in `.env` as `VITE_TLDRAW_LICENSE_KEY`; the web app reads the
   root `.env`.
5. **STT.** Web: on-device/browser recognition (no key). Desktop and browsers
   without it: server-side streaming adapters (Deepgram, AssemblyAI, and the
   Simurgh relay only when configured explicitly) — keys pending, see round 2.
6. **Search.** SearXNG (self-hosted, free) takes precedence when
   `SEARXNG_URL` is set; it ships in `deploy/docker-compose.yml` next to the API.
   Curated open sources work with no search at all.
7. **Prices.** Free / Standard $19 ($190 yearly) / Professional $38 ($380
   yearly). Stripe products still need creating (round 2).
8. **Ads.** On a topic miss the free plan shows one card while sources are
   gathered (ends the moment the session is usable), and that card is taken out
   of the session's ad budget (one card every 3 segments); otherwise never an ad
   at the start.
9. **Sentry.** Created in org `pen-playground`: `pen-academy-api`, `pen-academy-web`,
   `pen-academy-desktop`; DSNs are in `.env`. **PostHog:** its own account now,
   project `615574`, with the "Pen Playground — Sessions" dashboard; keys are in
   `.env` (`POSTHOG_PROJECT_TOKEN` / `VITE_POSTHOG_TOKEN` for ingestion,
   `POSTHOG_PERSONAL_API_KEY` for the API). Both products are off the Simurgh
   accounts entirely.
10. **Public sessions.** All sessions are public and the creator is never shown
    (host id and name are stripped from public records and ledgers).
11. **Languages.** Any language, with knowledge kept in English. Language
    identification is local and free: fastText's lid.176 model (900 KB, ~0.05 ms,
    23/23 on our short topic and question strings). English requests never touch
    a model. A non-English request needs one translation to the **English
    canonical title** (the key packs are stored under, so "من میخواهم سویفت را از
    پایه بیاموزم" and "I want to learn Swift" share one prepared pack) plus the
    language-bound check (Rumi's poems → Persian sources); that answer is cached on
    disk, so each distinct topic pays once ever. Communication follows the learner
    turn by turn: the utterance is identified locally in milliseconds, so even the
    instant acknowledgement ("Ah, muy buena.") is in the learner's language with
    the persona's voice for it; the model confirms the language on the note, and
    board, lesson and recognition follow — as many switches as the learner makes.
12. **Onten.** The host keeps the general-purpose surface (`ContextClient`) and
    shapes lessons through `contentInstructions`; nothing education-specific is
    assumed of Onten.

## Round 2 — needed from you

1. **Domain** for Pen Academy (e.g. `penacademy.ai`), DNS A record → prod-app-01's
   public IP. I will run certbot and deploy once it resolves.
   Answer: I registered another domain called: penplaygroud.com. I want this to be called Pen Playground instead of pen academy. The logo can be only Pen, but in description, we can say Pen playground, so short name is Pen. The domain is on hostinger, aceess that in the browswer and do whatever you need to do or add any DNS.
2. **Fish API credit** for `s2.1-pro` (https://fish.audio/app/developers), or
   confirm shipping on `s2.1-pro-free` until November.
   Answer: You can continue using this API, it has all the capabilities, before we go public, I wll replace it with a paid one. 
3. **PostHog:** either a personal API key with organisation scope (so I can
   create a `pen-academy` project) or a project token from a project you create.
   Answer: That is already in the Simurgh .env files. Find it and copy it in our .env file.
4. **STT key** for the desktop app: a Deepgram (recommended: Nova-3,
   $0.0048/min) or AssemblyAI key. Sign-up needs email verification, which I
   cannot complete for you.
   Answer: For Desktop app, use the 5090 GPU box we already use for the Simurgh.
5. **Stripe:** confirm I should create the four prices (Standard/Professional ×
   month/year) in the connected Stripe account (test mode first).
   Answer: Yes, use the stripe credintials in Simurgh project, and create these prices and packages.
6. **YouTube upload** needs a Google Cloud project with the YouTube Data API,
   OAuth consent screen and a verified brand (2–6 weeks). Do you want me to start
   that now?
   Answer: Work on a download instead. So the user can download their session and share it anywhere they want. Only paid users should be able to do that. 
