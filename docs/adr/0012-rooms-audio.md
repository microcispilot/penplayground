# ADR-0012: Rooms audio — self-hosted LiveKit, one microphone grant, host-only mute

Status: accepted · 2026-09-17 · completes phase 2 of ADR-0006

## Context

Professional hosts run rooms with up to 12 participants. Since ADR-0006 the
room shares the expert's voice and board over our own WebSocket and captions a
guest's question to everyone, but the humans cannot hear each other. Twelve
browsers exchanging raw voice needs an SFU (jitter, NAT traversal, packet-loss
concealment, active-speaker detection) — none of which belongs in the API.
Constraints that shaped the design:

- Every participant already holds one microphone grant for barge-in VAD and STT
  (`RoomSession` → `Microphone`). A second `getUserMedia` means a second prompt
  on some platforms, a second device handle, and two AGC loops fighting.
- The classroom rules are enforced server-side today (host authority, floor,
  plan). Voice must not open a side channel that bypasses them.
- No new paid service; the stack is one Hetzner host behind nginx.
- Solo sessions (the overwhelming majority) must not pay for any of it — no SDK
  download, no media connection.

## Decision

1. **Self-hosted `livekit/livekit-server` in the compose stack.** Signalling on
   `127.0.0.1:7880` behind the host nginx at `/livekit/`; media on `7881/tcp`
   and one multiplexed `7882/udp`, both public. Config in
   `deploy/livekit/livekit.yaml` (no secrets); the key pair is generated once by
   `deploy.sh` into `/srv/pen-playground/.env` and injected into both the
   `livekit` and `api` containers, so it is never typed twice. The feature is
   off unless `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are all
   set (`/api/health` → `rooms:false`, token route → `503`).
2. **The API is the only token authority.** `POST /api/rooms/:id/token` mints a
   join token (identity = participant id, name = display name, room = session
   id, TTL 3 h) only for a participant who is *already a member* of the live
   room — membership is the room's own participant list, which the WebSocket
   join enforces plan and capacity on. Publishing requires the host's plan to
   carry `rooms` (read from the host's participant row, so billing changes
   apply at once — same rule as `bearer`); a free host gets `402`. The host's
   token carries `roomAdmin`; guests' do not. The cue protocol stays on our
   WebSocket; LiveKit data channels are granted but unused (denying them only
   makes the SDK log an error on every connect).
3. **`participantAudio` on `RoomState`** tells clients whether this session has
   voice (host plan × media server). Clients connect only when it is true and
   only after `ready`, so the token route's membership check passes. Older
   ledgers omit the field and validate unchanged.
4. **One microphone grant.** `RoomSession` captures the `MediaStream` through
   the `Microphone`'s `getUserMedia` seam and hands the track to `RoomAudio`,
   which publishes a `clone()`. The clone shares the device and AEC/AGC with
   STT; stopping it on unpublish never stops the mic; stopping the mic
   unpublishes first. One mic button drives both.
5. **Host mute is a server call, not a client trick.** `POST
   /api/rooms/:id/mute` (host only) asks LiveKit's RoomService to mute every
   audio track of one guest, or of everyone but the host. LiveKit pushes the
   mute to the guest's client, which reports it as `mutedByHost`; only the
   guest can lift it (`enable_remote_unmute: false`). Mute affects the voice
   to the room only — the guest's mic keeps feeding STT so they can still ask
   the expert, per the classroom rules.
6. **Barge-in is unchanged.** Remote voices play through hidden `<audio>`
   elements so Chrome's echo canceller sees them, and `RoomAudio` reports
   "a remote human is speaking" to the `Microphone` the same way expert
   playback does (`setPlaybackActive`), so speaker bleed cannot open the mic
   while confirmed words still interrupt.
7. **Seams.** `AudioRoomPort` (connect / publish / unpublish / mute / events)
   hides `livekit-client`; `LiveKitAudioRoom` implements it with a lazy
   `import('livekit-client')`. `RoomServicePort` hides the server SDK's HTTP
   client. Both have fakes; the controller (`RoomAudio`) and the routes are
   unit-tested against them, and `apps/web/e2e/rooms.spec.ts` drives a host
   and a guest — two Chromium *processes*: a second context in one headless
   process shares the fake audio device and stalls ~20 s on every
   AudioContext — against a real `livekit-server --dev`.
8. **Recovery.** The SDK reconnects on its own; when it gives up, `RoomAudio`
   mints a fresh token and reconnects (1 s → 8 s backoff, five tries), then
   tells the participant honestly that voice dropped while the lesson goes on.

## Consequences

- Solo sessions: zero change (no SDK chunk, no media connection).
- The mute/kick surface is server-authoritative and testable without a media
  server; the media server never holds a secret the API does not.
- TURN is not deployed: clients that block UDP fall back to ICE over TCP 7881;
  a network that blocks both needs a TURN/TLS listener on 443 (a second IP or
  hostname) — tracked in `tasks/todo.md`.
- The expert does not yet join the media room as an agent (ADR-0006's export
  mix); the ledger still records only expert audio and captions of guests.
- `PEN_DEV_PLAN=professional` is how the e2e gives the host the entitlement;
  the same lever exercises rooms locally.
