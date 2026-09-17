# syntax=docker/dockerfile:1.7
# Pen Academy API — production image.
#
# Build from the repository root (the pnpm workspace is the context):
#   docker buildx build --platform linux/amd64 -f services/api/Dockerfile -t pen-academy-api:<tag> .
#
# Stages: manifests (package.json skeleton for a cacheable install) → deps (workspace subset)
# → build (esbuild bundle + pruned production node_modules) → runtime (node, non-root).
# Base tag verified on Docker Hub (library/node) on 2026-09-16.

ARG NODE_IMAGE=node:22-alpine

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
COPY . .
RUN pnpm --filter @pen/api build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @pen/api deploy --legacy --prod --config.node-linker=hoisted \
      --store-dir /pnpm/store /out \
 && rm -rf /out/src /out/scripts /out/test /out/tsconfig.json /out/vitest.config.ts

# ── runtime ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="Pen Academy API" \
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
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PEN_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
