# ADR-0006: Rooms — cue broadcast over our WebSocket; human voice via LiveKit in phase 2

Status: accepted · 2026-09-16

## Context
Up to 12 participants must share the expert's voice and board and be able to
interrupt. Human-to-human voice among 12 needs an SFU (jitter, NAT, PLC).
LiveKit is Apache-2.0 self-hostable with a Node Agents SDK.

## Decision
- Phase 1: the API hosts rooms over WebSocket. Host authority (pause/resume/end)
  enforced server-side. Each participant's mic goes to STT; their question is
  captioned to the room and the expert answers the room. Guest voice is not
  relayed raw.
- Phase 2: LiveKit rooms for human voice; the expert joins as an agent
  participant (also yields a mixed track for export).

## Consequences
The classroom works for questions and shared teaching immediately; live
chatter among humans arrives with LiveKit without changing the cue protocol.
