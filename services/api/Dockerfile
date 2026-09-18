# syntax=docker/dockerfile:1.7
# Pen Playground API — production image.
#
# Build from the repository root (the pnpm workspace is the context):
#   docker buildx build --platform linux/amd64 -f services/api/Dockerfile -t pen-academy-api:<tag> .
#
# Stages: manifests (package.json skeleton for a cacheable install) → deps (workspace subset)
# → build (esbuild bundle + pruned production node_modules) → runtime (node, non-root).
# Base tag verified on Docker Hub (library/node) on 2026-09-16.
#
# MP4 export (paid feature) needs headless Chromium + ffmpeg in the API container. Build with
#   --build-arg WITH_RENDER=1
# to base the runtime on Microsoft's Playwright image (Ubuntu noble, Node 22, the exact Chromium
# Playwright 1.63 drives, all system deps) plus apt ffmpeg. It is ~1.9 GB vs ~250 MB for the
# Alpine runtime, and it is the only combination verified to run Playwright's recordVideo: the
# Alpine route (musl chromium + Playwright's static ffmpeg) is smaller but not supported by
# Playwright, so it is deliberately not offered. Without the arg the API boots with export
# disabled (`/api/health` → render:false, POST export → 503 RENDER_UNAVAILABLE).
#
# Sentry source maps: mount the auth token as a BuildKit secret and the bundle's map is uploaded
# under release = GIT_SHA (the bundle carries the matching debug id and release):
#   --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN --build-arg GIT_SHA=$(git rev-parse HEAD)
# Without the secret the build is identical minus the upload.

ARG NODE_IMAGE=node:22-alpine
# Tag matches the `playwright` npm version pinned in services/api/package.json.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble
ARG WITH_RENDER=0

# ── base: pnpm via corepack ───────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
WORKDIR /app

# ── manifests: only package.json files + lockfile, so `deps` caches until a manifest changes ──
FROM base AS manifests
COPY . /src
RUN find /src -mindepth 2 -type f ! -name package.json -delete \
 && find /src -mindepth 1 -type d -empty -delete

# ── deps: the workspace subset the API needs (dev deps included: tsx/esbuild build the bundle) ──
FROM base AS deps
COPY --from=manifests /src/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pen/api..." --store-dir /pnpm/store

# ── build: bundle, then a hoisted production node_modules for the bundle's externals ──
FROM deps AS build
ARG GIT_SHA=unknown
ARG SENTRY_ORG=pen-playground
COPY . .
RUN --mount=type=secret,id=sentry_auth_token \
    sh -eu -c ' \
      if [ -s /run/secrets/sentry_auth_token ]; then \
        export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)" SENTRY_RELEASE="$GIT_SHA"; \
      fi; \
      pnpm --filter @pen/api build'
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @pen/api deploy --legacy --prod --config.node-linker=hoisted \
      --store-dir /pnpm/store /out \
 && rm -rf /out/src /out/scripts /out/test /out/tsconfig.json /out/vitest.config.ts

# ── runtime bases: plain node (default) or Playwright + ffmpeg (WITH_RENDER=1) ──
FROM ${NODE_IMAGE} AS runtime-base-0
# uid 1000 is `node` here; nothing to add.

FROM ${PLAYWRIGHT_IMAGE} AS runtime-base-1
# Chromium lives in /ms-playwright (world-readable); ffmpeg for the mux comes from apt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && (id -u node >/dev/null 2>&1 || (getent passwd 1000 >/dev/null && usermod -l node "$(getent passwd 1000 | cut -d: -f1)" && groupmod -n node "$(getent group 1000 | cut -d: -f1)") || useradd -m -u 1000 node)
ENV PEN_FFMPEG_PATH=/usr/bin/ffmpeg \
    PEN_CHROMIUM_ARGS=--disable-dev-shm-usage

# ── runtime ───────────────────────────────────────────────────────────────────
FROM runtime-base-${WITH_RENDER} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="Pen Playground API" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production \
    PEN_PORT=4000 \
    PEN_DATA_DIR=/data \
    PEN_MIGRATIONS_DIR=/app/dist/drizzle \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
# package.json carries "type": "module" so dist/main.js loads as ESM.
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# Experts catalog, portraits, voices and seed packs; resolved as dist/../data by the server.
COPY --from=build --chown=node:node /out/data ./data
RUN mkdir -p /data && chown node:node /data
# The Playwright image ships /ms-playwright for root; the renderer runs as `node`.
RUN if [ -d /ms-playwright ]; then chmod -R a+rX /ms-playwright; fi
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PEN_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
