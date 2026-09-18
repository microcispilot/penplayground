# Pen Playground

[![CI](https://github.com/microcispilot/penplayground/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/microcispilot/penplayground/actions/workflows/ci.yml)

Learn anything from a hyper-real AI human expert who talks to you and writes on a
shared board at a human pace, stops the instant you speak, answers from prepared
evidence, and picks the lesson back up. Web and desktop share one product
package; the API is a Node service.

Docs: `docs/PRODUCT.md` (vision + storyboards), `docs/SPEC.md`,
`docs/CAPABILITY-MAP.md`, `docs/GLOSSARY.md`, `docs/COST.md`, `docs/adr/`,
`docs/QUESTIONS.md` (decisions still needed), `tasks/plan.md`, `tasks/todo.md`.
Operating it: `docs/DEPLOY.md` (how the stack is built) and
`docs/RUNBOOK.md` (deploy, rollback, backups, secrets, incidents).

## Quick start (no keys needed)

```
pnpm install
cp .env.example .env            # then edit; PEN_PORT=4010 if :4000 is taken
# terminal 1 — API with the scripted model and silent voice
cd services/api && PEN_PORT=4010 PEN_LLM_PROVIDER=fake PEN_TTS_PROVIDER=silent pnpm dev
# terminal 2 — web
cd apps/web && PEN_API_PORT=4010 pnpm dev      # http://localhost:5173
```

Type "How Transformers work in LLMs" and press Start. With real keys in `.env`
(`OPENAI_API_KEY_*`, `FISH_AUDIO_API_KEY`) drop the two provider overrides:
unknown topics are prepared live from licensed sources and the expert speaks
with Fish Audio.

## Verify

```
pnpm verify                     # biome + typecheck + vitest, every package
cd apps/web && PEN_API_PORT=4010 pnpm e2e     # Playwright, full Chromium
```

## Layout

```
packages/app            the product (screens, room client, conductor wiring, state)
apps/web, apps/desktop  thin hosts: a Platform adapter each
services/api            Hono HTTP + WebSocket, rooms, ledger, identity, billing
packages/*              contracts · design · onten · llm · voice · board ·
                        session-engine · conductor · knowledge · db
```
