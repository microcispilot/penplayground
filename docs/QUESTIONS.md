# Questions for the founder

Things I could not resolve from the repos, the mockup or the research. I built
under the stated assumption in each case; correcting any of them is cheap.

1. **"hotzinger" server.** The name appears in no repository. The only server I
   found is the Simurgh GPU box reached over SSH (`SIMURGH_DEPLOY_SSH_HOST`).
   Is "hotzinger" that machine, a Hetzner box, or something else? What runs
   where (API, Postgres, TTS bridge, STT)? *Assumed: one Linux host with an
   RTX 5090 running the Simurgh tts-bridge and STT, plus a Node API.*
2. **Fish Audio key.** `.env-use` has no Fish Audio cloud key
   (Simurgh's name is `SIMURGH_GUIDE_FISH_CLOUD_API_KEY`). Should I use the
   Simurgh account's key, or a new Pen Academy account? Also: the self-hosted
   Fish Speech S2 Pro on the 5090 is under the Fish Audio Research License
   (commercial use needs a written license from Fish). Do you have that
   license? *Assumed: Fish cloud `s2.1-pro` for production, `s2.1-pro-free`
   (free until 2026-11-30) for development.*
3. **Voice mapping.** Which Fish reference ids should map to the catalog voice
   ids (`af_heart`, `am_adam`, …)? Simurgh keeps the mapping in
   `SIMURGH_GUIDE_FISH_CLOUD_VOICES`; I read it as `PEN_VOICE_MAP`.
4. **tldraw license.** Production needs a commercial key (trial is 100 days;
   hobby key shows a watermark and is non-commercial; startup pricing by
   application, reportedly ≈ $6k/year). Shall I apply for the startup program,
   or should the board be built on an MIT engine (Excalidraw) instead?
   *Assumed: tldraw, trial key for now.*
5. **STT provider.** Cheapest verified hosted streaming STT is AssemblyAI
   ($0.15/hour) then Deepgram Nova-3 ($0.0048/min); self-hosted NVIDIA
   Nemotron-3.5-ASR-Streaming-0.6B on the 5090 is ~$0. The web app works today
   with on-device browser recognition (no key). Which should be the default for
   production, and may I create Deepgram/AssemblyAI accounts?
6. **Search provider for topic misses.** Tavily (~$0.56/topic) or self-hosted
   SearXNG + Crawl4AI (~$0.05/topic, needs a VPS). No keys exist. Which one?
   *Assumed: curated open sources (swift-book, rust-book, MDN, Python docs,
   Wikipedia) without a search key; Tavily when `TAVILY_API_KEY` is set.*
7. **Prices.** Proposed Free / Plus $12 / Classroom $29 per month (yearly two
   months free). Confirm or change before Stripe products are created.
8. **Ads.** Skippable card between segments every 3 segments on Free, never
   inside the audio. Which ad network (AdSense, a direct partner, none yet)?
9. **Sentry.** Should Pen Academy get its own Sentry projects in org
   `o4511870200381440`? I can create them with `SENTRY_AUTH_TOKEN` if you say so.
10. **Public by default?** New sessions are public (they appear in "Most
    learned") unless created private. Correct?
11. **Languages.** English only at launch? Fish s2.1-pro and the pipeline are
    multilingual; the registry keys packs by language.
12. **Onten integration timing.** The mock mirrors the `ContextClient` JSONL
    surface. When the Rust binary is buildable, do you want the API to spawn it
    (as `sdk/context` does) or to talk to a service?
