# Questions for the founder

Things I could not resolve from the repos, the mockup or the research. I built
under the stated assumption in each case; correcting any of them is cheap.

1. **"hotzinger" server.** The name appears in no repository. The only server I
   found is the Simurgh GPU box reached over SSH (`SIMURGH_DEPLOY_SSH_HOST`).
   Is "hotzinger" that machine, a Hetzner box, or something else? What runs
   where (API, Postgres, TTS bridge, STT)? *Assumed: one Linux host with an
   RTX 5090 running the Simurgh tts-bridge and STT, plus a Node API.*
   Answer: Simurgh project has all the keys you get get what you need from there. it's not hotzinger, it's hetzner. You can connect view ssh. 
2. **Fish Audio key.** `.env-use` has no Fish Audio cloud key
   (Simurgh's name is `SIMURGH_GUIDE_FISH_CLOUD_API_KEY`). Should I use the
   Simurgh account's key, or a new Pen Academy account? Also: the self-hosted
   Fish Speech S2 Pro on the 5090 is under the Fish Audio Research License
   (commercial use needs a written license from Fish). Do you have that
   license? *Assumed: Fish cloud `s2.1-pro` for production, `s2.1-pro-free`
   (free until 2026-11-30) for development.*
   Answer: Added the key to the .env. Do not use 5090. That box is only for Simurgh. This system should not use that box. If STT costs us, then use the STT in that box, the way Simurgh uses it (but only if it's really the only best and lowest cost way), othwerwise avoid it because it's over a home internet and not stable.
3. **Voice mapping.** Which Fish reference ids should map to the catalog voice
   ids (`af_heart`, `am_adam`, …)? Simurgh keeps the mapping in
   `SIMURGH_GUIDE_FISH_CLOUD_VOICES`; I read it as `PEN_VOICE_MAP`. 
   Answer: Use the latest pro voices and for men, different personas can share different high quality men voices and for women, the same. So if there are 20 high quality and realistic and natural voices, you can assign the same voice to 5 different personas, for example. You should avoid assigning no high quality voices. Everything in this platform should contribute to highest quality and naturality and super hyper realistic.
4. **tldraw license.** Production needs a commercial key (trial is 100 days;
   hobby key shows a watermark and is non-commercial; startup pricing by
   application, reportedly ≈ $6k/year). Shall I apply for the startup program,
   or should the board be built on an MIT engine (Excalidraw) instead?
   *Assumed: tldraw, trial key for now.*
   Answer: Added to the .env file. 
5. **STT provider.** Cheapest verified hosted streaming STT is AssemblyAI
   ($0.15/hour) then Deepgram Nova-3 ($0.0048/min); self-hosted NVIDIA
   Nemotron-3.5-ASR-Streaming-0.6B on the 5090 is ~$0. The web app works today
   with on-device browser recognition (no key). Which should be the default for
   production, and may I create Deepgram/AssemblyAI accounts?
   Answer: Yes, you can create the accounts, if that's the high quality and low latency enought. if we can achive that with on-device browser recognition, then that's great.
6. **Search provider for topic misses.** Tavily (~$0.56/topic) or self-hosted
   SearXNG + Crawl4AI (~$0.05/topic, needs a VPS). No keys exist. Which one?
   *Assumed: curated open sources (swift-book, rust-book, MDN, Python docs,
   Wikipedia) without a search key; Tavily when `TAVILY_API_KEY` is set.*
   Answer: go with the cheapest one if the quality and speed is not much different. Tell me what exactly you need me to do. 
7. **Prices.** Proposed Free / Standard $19 / Profesional $38 per month (yearly two
   months free). Confirm or change before Stripe products are created.
8. **Ads.** Skippable card between segments every 3 segments on Free, never
   inside the audio. Which ad network (AdSense, a direct partner, none yet)?
   Answer: Please not that you need to properly engineer this. When Onten did not return a plan for what the user searched, and we need to do search and gather information and documents, this is an opportunity to show ads, and if the system found usable information that can continue with the session, then we show the ads based on waht you mentioned. So the total number of ads stays the same but showing an ad at the start after search until consumable data is prepared is just depends on what I mentioned above, otherwise never ad at the start.
9. **Sentry.** Should Pen Academy get its own Sentry projects in org
   `o4511870200381440`? I can create them with `SENTRY_AUTH_TOKEN` if you say so.
   Answer: Yes, do it. Same for posthog. 
10. **Public by default?** New sessions are public (they appear in "Most
    learned") unless created private. Correct?
    Answer: All the sessions can be public like how any youtube video is public, but we don't show the person who created/started that session. 
11. **Languages.** English only at launch? Fish s2.1-pro and the pipeline are
    multilingual; the registry keys packs by language.
    Answer: all possible languages. I don't see any reason you would make it limited to English. 
12. **Onten integration timing.** The mock mirrors the `ContextClient` JSONL
    surface. When the Rust binary is buildable, do you want the API to spawn it
    (as `sdk/context` does) or to talk to a service?
Answer: you build it the best way you want onten to be, do not worry, onten team can change whatever works best for us, but they definately have the Onten as a general purpose system, not only for education and learning. So you just assume it whatever way you think is the best possible and whatever you need it to give you and in any format. 