# Pen Playground — Product Definition

> "Something between YouTube, a classroom, and an expert over Zoom."
> Learn anything from a hyper-real AI human expert who talks to you and writes
> on a shared board, at a human pace, and stops the moment you speak.

## The user's moment

A learner opens Pen Playground with one sentence in their head: *"I want to learn
Swift."* They are not looking for a course catalog. They want the feeling of
sitting across from a patient expert who already has the whiteboard marker in
hand. Within seconds the expert is talking, writing the first idea on the board
and inviting the learner to interrupt. When the learner asks "what if I use
`let` instead of `var` here?", the expert answers *that* question, on *that*
board, and then picks the lesson back up where it stopped.

Everything below serves that moment.

## Product bar (Siri / ChatGPT Voice launch-review standard)

| # | Bar | What it means for Pen Playground | Metric |
|---|-----|-------------------------------|--------|
| 1 | Zero-friction activation | Type or say the topic, press Start. No sign-in to try. No wizard. | Clicks to first spoken sentence = 1 |
| 2 | Latency is the product | Prepared topic: expert speaks < 1.5 s after Start. Question: first audible reply ≤ 800 ms after the learner's last word (ceiling 1200 ms). | time-to-first-audio p50/p95 |
| 3 | The voice is the brand | Fish Audio S2.1 Pro at native 44.1 kHz, sentence-streamed, barge-in fade ≤ 150 ms. | barge-in latency, MOS spot checks |
| 4 | Generality | Any topic. A miss is a *preparing* state, never a "not supported". | topic-miss recovery rate |
| 5 | Trust engineered visibly | Mic state always visible. The "AI expert" disclosure where it is read — the pill on a saved session, what every expert says when asked, and the Terms page in full — rather than a line in the furniture of every screen. Sources shown for every answer. Host-only controls are explicit. | 0 privacy surprises |
| 6 | One magic moment in the first minute | Start → hear the expert → see the board being written → interrupt with a question → get a grounded answer. All within 60 s. | first-session completion |

## The app shell (ADR-0015)

Every screen but the live session and the replay sits in one shell: the header,
and a persistent left sidebar — 240 px, collapsible to a 72 px icon rail that is
remembered, a drawer under 1024 px. The sidebar is what the platform has:

- **Learn** — Home, Experts, Topics (the domains, which filter Home's grid), Pricing.
- **You** — History, Learn later, Liked, Your sessions, Downloads (Standard),
  Rooms (Professional). The same rows whether or not you have signed in: an
  anonymous participant really does own its sessions, saves and likes on this
  device, and signing in with Google brings them along. Plan rows carry the
  plan's name, never a lock.
- **Settings** — theme. The pace lives in the session it is felt in, and is
  kept on the account from there (ADR-0010), the way a video's playback speed
  is: a signed-in learner's next session opens at it on any device.
- **Bottom** — Terms · Privacy · © 2026 Microcis.

Identity is the header's account chip and nowhere else. Signed out it reads
"Sign in"; signed in it is the learner's picture — or a letter avatar — and
their first name, which is how every other app says "this is you".

In the room the board *is* the screen: no shell, nothing else to look at.

## The screens

1. **Home** — "What do you want to learn?" search with a mic; "Most learned"
   grid of public sessions (YouTube feel) with category chips and a filter.
2. **Experts** — all 105, filterable by domain and by name; picking one lands
   back on Home with that expert already in the command bar. Home shows twelve
   of them in a row and ends it with one more card that leads here. The ten
   historical recreations are part of a plan (ADR-0020): six with Standard, all
   ten with Professional. A learner without that plan still sees the face and
   the name, with the plan's name on the card — never a lock, never a warning.
3. **Your sessions** — the watch page, in YouTube's shape (ADR-0044): the
   board, the title, the expert as a channel row with the actions beside it,
   a description box, comments, and *Up next* on the right. The board is the
   player (ADR-0045): press it, or arrive from a card, and the lesson starts
   again, live, as a fresh session of your own (ADR-0035) in that box; a
   press on the board pauses and resumes; *Full view* is the board and its
   controls alone. A host with an account also has *Watch my recording*,
   *Download* (with or without their questions), their own questions, and
   Delete; making it private is Standard. Share, one button and one sheet,
   for everyone. Comments: everyone reads, an account writes, the author and
   the host delete.
4. **History / Learn later / Liked / Downloads / Rooms** — the learner's own
   shelves. A heart and a bookmark on every card and on the session page fill
   them; the like count is public, the shelf is not.
5. **Preparing** — expert portrait breathing, topic title, "9 steps · about 14
   minutes", one progress bar, honest status lines. Only shown on a knowledge
   miss; a prepared topic skips straight to the room.
6. **Live session** — the board takes most of the screen, with the session
   panel beside it (ADR-0019): everyone on the call with the AI human first and
   whoever is talking ringed, and the chat between the people in the room. The
   expert is on the call and not in the chat — it never reaches them, never
   interrupts, and nothing they say is written into it; you ask them something
   by saying it, the way you interrupt a person. The panel folds away from a
   chevron on its own edge and the board takes the width. The board carries no
   transcript and no names: captions are off until the CC control turns them
   on, and then they are subtitles — the words, with nobody's name in front of
   them. Nothing about the learner is ever written on the board — no name, no
   "you asked" note — because a real expert does not write the asker on the
   whiteboard; in a room the chat shows who asked what, and in a solo session
   the learner asked it themselves. Check-in questions, which are the expert's
   own, stay on the board. A
   bottom bar carries progress dots, clock, pause (host), captions, mic,
   reactions, the panel, fullscreen and Leave.
7. **Recap** — what was covered, your questions, save / learn something else.
8. **Terms of Use · Privacy Policy** — reachable from the bottom of the sidebar
   and from Home's footer. Plain, current, and true to what the product does:
   sessions are recorded and public by default with your name never shown.

## Storyboard: prepared topic, single learner

| t (ms) | Voice (expert) | Board | System |
|-------:|----------------|-------|--------|
| 0 | — | Home. Learner types "How Transformers work in LLMs", Enter. | Registry lookup (Onten): hit. Session created. |
| 250 | — | Room fades in. Board is blank paper. Orb "watching". | First lesson segment streamed from cache/LLM. |
| 900 | "Let's start with a sentence. Six tokens — that's everything the model sees at first." | Hand writes `the cat sat on the mat` word by word, ink navy, ~10 chars/s. | Audio clock is master; board cues anchored to the sentence. |
| 6 000 | "Each token becomes a vector…" | Draws six boxes under the words, one per beat. | Progress dot 1 → 2. |
| 41 000 | *(learner speaks)* "Wait, why divide by the square root of d?" | Board dims 55 %. Caption shows "You: …" live. | VAD confirms speech in 240 ms → audio fades out in 20 ms → lesson paused at cue 6.3. |
| 41 600 | — | — | STT final. Onten AnswerContext (sufficient, 4 spans) in < 20 ms. LLM first sentence streamed. |
| 42 300 | "Good one. Without it the dot products get huge as the vectors get longer…" | Nothing new on the board unless the answer needs a sketch; the question is never written there. | The question is in the host's own recording; in a room, the chat shows who asked. |
| 55 000 | "Okay — back to where we were." | Board undims. | Lesson resumes at cue 6.3 with a bridge phrase, not a restart. |
| 300 000 | "Quick one back at you — when 'sat' attends to 'cat', what is actually being compared?" | Three choices appear. Orb glows green. | Check-in. Learner answers by voice. Graded from evidence, never from vibes. |
| 840 000 | "That's the whole block. Stack it thirty-two times…" | Final diagram complete. | Session complete. Recap panel. Saved to My sessions. |

## Storyboard: topic miss ("I want to learn Swift fundamentals")

| t | Voice | Screen | System |
|---|-------|--------|--------|
| 0 | — | Preparing: "Reading the Swift language guide…" | Registry miss → corpus builder starts. Outline model produces curriculum + source list in ~5 s. |
| 5 s | — | "Found 14 sources · preparing the first lesson" | Sources fetched in parallel; first three documents pushed to Onten; provisional pack compiles. |
| 12–25 s | "Hi, I'm Dario. Swift first — the language, then the habits." | Room opens. Board: "Swift fundamentals · 8 steps". | `interactive` promise resolved: provisional context (status `partial`, tier `unverified_live_source`). Expert is honest: "I'm still pulling the rest of the docs in as we go." |
| background | — | Small "preparing 9/14 sources" pill in the bottom bar. | `background` compile continues; when qualified, the next question hits the qualified pack. |

Waiting is engaging: the expert portrait is already there, the outline is
written on the board while sources arrive, and the learner can ask a question
during preparation.

## Classroom rules (host, guests, up to 12)

- **A room is recorded for its host, and everyone is told** (ADR-0035): the
  bar carries a steady *Recording* mark while there are guests, and a guest
  is told once as they take their seat that the session is being recorded
  and that only the host can watch or download it — the way a call says it.
  Only the host watches or exports the recording, and it holds everything:
  the lesson, every guest's questions, the answers.
- **A room is not replayed.** Replay is for solo sessions; a room's page
  offers its host the recording and everyone else the way to search the
  topic, whose lesson the memo already holds.

- **Host** starts, pauses, resumes, ends, invites, mutes and removes. The host
  is the one voice the expert always hears: they interrupt as a solo learner
  does, and may cut in over a guest's turn. Only the host's pause pauses
  the room.
- **Discussion** (ADR-0037): the host's control that pauses the class to
  talk among themselves. The lesson stops at the sentence, the expert dims
  and waits, and nobody's voice reaches it — the host's included — until the
  host brings the expert back.
- **Guests** join by link, hear everything, see the board, and **raise a
  hand** to ask. The expert takes hands in the order raised, at the end of
  the sentence it is on, by name — *"Okay Tom, I see your hand — go ahead"*
  — and then Tom has the floor. A guest who is not called on is never heard
  by the expert (the room hears them); one who says nothing for a few
  seconds, or lowers their hand, is let go by name and the lesson carries
  on. A hand lowered before the call is simply gone; raised again, it joins
  the back of the queue.
- A hand raised during a discussion, a pause or an ad waits, and is taken at
  the first sentence boundary after the lesson resumes.
- **Reactions** are how a room of twelve says something without taking the floor
  (ADR-0019): eight emoji, one tap, the sender's face beside their emoji over the
  participants for a few seconds. They never interrupt the expert, and the one
  that says "I am lost" is there on purpose.
- Everyone sees the same cue stream; the board renders identically on every
  client (deterministic cues, not pixel streaming).

## Packaging (why two paid tiers)

| Tier | Price idea | What it buys |
|------|-----------|--------------|
| **Visitor** (no account) | $0, ad-supported | A taste, never a cost (ADR-0040): search and start any lesson that is already prepared, as many as they like, 20 minutes each, taught by Elena Ruiz or Soren Vale — one of the two chosen at random for the visit and sitting in the search box. Check-ins, pace, the board. Questions are heard and answered with a warm line asking for an upgrade, never the model. No history, saves, likes, recording or download; every one of those is the invitation to sign in. |
| **Free** (an account) | $0, ad-supported (a skippable YouTube-style video ad between segments; on a topic miss one ad runs while sources are gathered, counted against the same budget) | Everything the visitor has, plus history, your sessions, saved, liked and your own recording — and **one custom session**: one topic nobody has prepared, prepared for them (`PEN_FREE_CUSTOM_SESSIONS`). After it, the way to more is an upgrade, said kindly with the lessons that are ready. Same two experts; questions still ask for an upgrade. |
| **Standard** | $19/mo ($190/yr) | No ads. The expert answers questions live, and writes the recap. Any topic, prepared for you, without limit. Every modern expert and six legends; a default expert of your own in the search box. 45 minutes a session. Export MP4 + share to YouTube/social. Premium voices. Priority preparation on topic misses. |
| **Professional** | $38/mo ($380/yr) | Everything in Standard, 60 minutes a session. Host rooms with up to 12 participants (11 guests). The whole class recorded — every guest's questions included — for the host to watch or export, like a Zoom recording. Class transcripts. |

Ads never appear inside the live lesson audio; they are a visible in-stream
**video** over the board between segments (only video, like YouTube), labelled
"Ad · 1 of 1" with a countdown, skippable after 5 s whatever the creative says,
never longer than 30 s, and never on paid tiers. If the ad cannot load (blocker,
no fill) the lesson resumes within 2 s — no dead air. Demand comes from the
highest-paying network a new site can join, Google Ad Manager through the IMA
SDK, behind one swappable tag (ADR-0014, `docs/ADS.md`).

## What a plan gets, and where (ADR-0036)

Every part of the product a plan may or may not have — preparing a topic
nobody has prepared, hosting a room, downloading a recording, the ads, the
chat, Google sign-in on a desktop — is a **feature flag**: a rule over the
plan and the platform, with a compiled-in default the product runs on with
nothing stored, changed from the operations console's Features screen and
landing on the next session. The client is told its own cell and hides what
is off; the server decides every time. A free learner whose topic nobody has
prepared is told so under the box they typed into, with the way to upgrade
and the lessons that are ready now — an answer, not a closed door.

## What the limits feel like (ADR-0016, ADR-0018, ADR-0040)

The caps above are enforced on the server — `PLAN_LIMITS` in
`packages/contracts/src/billing.ts` is the only table, with the free plan's
custom-session allowance beside it as `PEN_FREE_CUSTOM_SESSIONS` — and they are
*explained* rather than sprung. There is no daily count any more: a free session
is a prepared lesson replayed, and the ads pay for it. What a plan does not
include is said where the learner reached for it, in one sentence, with the way
in: a visitor who asks a question hears the expert say so and sees the way to
Pricing beside the board; a visitor who likes a card is shown the sign-in sheet
there; a free account asking for a second custom session is offered an upgrade
under the box it typed into, with the lessons that are ready. There is no red
box, no lock icon and no warning tone anywhere in the product: a limit is a fact
about a plan, not a fault.

On a day when the whole service has spent its budget (`PEN_DAILY_SPEND_CAP_USD`,
ADR-0016) free sessions wait until midnight UTC while paid plans keep going,
and the page says exactly that.

**Privacy is the same idea.** There is no consent banner, because there is
nothing to consent to: analytics are cookieless and content-free, ads are
non-personalised everywhere and limited in Europe. A quiet "Privacy choices"
link in the footer shows what is collected and turns analytics off — on this
device and on the server — and "Delete account" in the account sheet removes
the account, every session it hosted and everything those sessions recorded.

## Cost thesis

Onten hands the model everything it needs (≤ 2 000 tokens) in < 20 ms, so the
composing model can be the cheapest, lowest-reasoning, zero-tool-call model.
The budget per 20-minute solo session is the number the whole architecture is
built around: see `docs/COST.md`.

## What would the launch review flag?

- Any state in which the expert is silent and nothing is written on the board
  for > 2 s without an honest status line.
- Board text that appears all at once.
- A TTS artifact at a chunk seam.
- A resume that picks up mid-sentence. A person cut off says "so, as we
  said…" and starts the sentence again; the expert does the same (a bridge
  line, then the cut sentence from its first word), and never resumes from
  a word in the middle of one.
- A guest who cannot tell whether the room is paused or listening to them.
