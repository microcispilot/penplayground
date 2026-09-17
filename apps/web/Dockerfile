# syntax=docker/dockerfile:1.7
# Pen Playground web — static Vite build served by nginx, which also proxies /api, /experts, /s
# and the /ws WebSocket to the API container (deploy/web/nginx.conf).
#
# Build from the repository root:
#   docker buildx build --platform linux/amd64 -f apps/web/Dockerfile -t pen-academy-web:<tag> \
#     --build-arg VITE_TLDRAW_LICENSE_KEY=… --build-arg VITE_SENTRY_DSN=… .
#
# VITE_API_URL is deliberately left unset so the app talks to its own origin (the WebSocket URL is
# derived from it; an empty string would break that). Empty build args are unset before the build.
# Base tags verified on Docker Hub (library/node, library/nginx) on 2026-09-16.

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.30-alpine

# ── base: pnpm via corepack ───────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
WORKDIR /app

# ── manifests: package.json skeleton so `deps` caches until a manifest changes ──
FROM base AS manifests
COPY . /src
RUN find /src -mindepth 2 -type f ! -name package.json -delete \
 && find /src -mindepth 1 -type d -empty -delete

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY --from=manifests /src/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pen/web..." --store-dir /pnpm/store

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
ARG VITE_API_URL=""
ARG VITE_TLDRAW_LICENSE_KEY=""
ARG VITE_SENTRY_DSN=""
ARG VITE_POSTHOG_TOKEN=""
ARG VITE_POSTHOG_HOST=""
COPY . .
RUN sh -eu -c ' \
      for v in VITE_API_URL VITE_TLDRAW_LICENSE_KEY VITE_SENTRY_DSN VITE_POSTHOG_TOKEN VITE_POSTHOG_HOST; do \
        eval "val=\${$v:-}"; [ -n "$val" ] || unset "$v"; \
      done; \
      pnpm --filter @pen/web build'

# ── runtime ───────────────────────────────────────────────────────────────────
FROM ${NGINX_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="Pen Playground web" \
      org.opencontainers.image.revision="${GIT_SHA}"
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
