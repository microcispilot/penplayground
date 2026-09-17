# ADR-0001: TypeScript monorepo, Vite SPA web app, Hono API, Electron desktop

Status: accepted · 2026-09-16

## Context
Pen Playground must run as a web app and as desktop apps (macOS/Windows/Linux), in
TypeScript, reusing Simurgh's TypeScript client pieces (ears/mouth/orb) and
its Fish S2-Pro bridge (a Python service we call over HTTP; not re-implemented).
Research (2026-09): Vite 8, React 19.3, Tailwind 4.3, Hono 4.13, Drizzle 1.0-rc,
Electron 44 (Chromium 152), pnpm 12, Turborepo 2.10, Vitest 5, Playwright 1.63,
Biome 2.5. Tauri 2 is rejected because WKWebView/WebKitGTK media-capture gaps
(mic prompt bugs, no WebGPU, WebKitGTK media streams disabled) are disqualifying
for a voice-first recorder.

## Decision
- pnpm workspaces + Turborepo. Node ≥ 22.
- `packages/app`: the entire product UI (screens, room client, conductor
  wiring, state) as a React 19 library. Anything a client can only do
  natively enters through one `Platform` interface (mic, speech recognition,
  file export, window, updates).
- `apps/web`: thin Vite host: entry file, router shell, the web `Platform`
  adapter. Public share pages get OG metadata from the API (`/s/:id`) so no
  SSR framework is needed.
- `apps/desktop`: thin Electron Forge host (configuration shape copied from
  Simurgh) with the desktop `Platform` adapter. Same UI, same behaviour.
- `services/api`: Hono on Node with `ws` for WebSockets; Drizzle ORM; Postgres
  18 in production, PGlite (embedded Postgres with pgvector) for dev and tests.
- Tailwind 4 with CSS-first tokens from `packages/design`; Biome for lint/format;
  Vitest for unit/integration; Playwright for e2e.

## Consequences
One language end to end; every module is testable in Node. Next.js is not used
(no server components needed; tldraw and audio are client-only). SSR can be
added later behind the API for marketing pages.
