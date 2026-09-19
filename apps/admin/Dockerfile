# syntax=docker/dockerfile:1.7
# Pen Playground operations console — a static Vite build served by nginx, which proxies /api to
# the API container (deploy/admin/nginx.conf). Its own image and its own vhost, so the console
# never shares an origin, a Content-Security-Policy or a stored token with the public site.
#
# Build from the repository root:
#   docker buildx build --platform linux/amd64 -f apps/admin/Dockerfile -t pen-playground-admin:<tag> \
#     --build-arg VITE_GOOGLE_CLIENT_ID=… .
#
# VITE_GOOGLE_CLIENT_ID is the only build arg the console needs: it signs in with the same Google
# client the learner app uses, and the API decides whether that account may be here
# (`PEN_ADMIN_EMAILS`, ADR-0025). VITE_API_URL is deliberately unset — nginx in this image proxies
# /api to the API container, so the browser only ever talks to this origin.
#
# Sentry source maps work exactly as they do for the web image: mount the token as a BuildKit
# secret and the maps upload under release = GIT_SHA, then leave the bundle.
# Base tags verified on Docker Hub (library/node, library/nginx) on 2026-09-16.

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.30-alpine

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

FROM base AS deps
COPY --from=manifests /src/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pen/admin..." --store-dir /pnpm/store

FROM deps AS build
ARG VITE_GOOGLE_CLIENT_ID=""
ARG VITE_SENTRY_DSN=""
ARG GIT_SHA=unknown
ARG SENTRY_ORG=pen-playground
COPY . .
RUN --mount=type=secret,id=sentry_auth_token \
    sh -eu -c ' \
      for v in VITE_GOOGLE_CLIENT_ID VITE_SENTRY_DSN; do \
        eval "val=\${$v:-}"; [ -n "$val" ] || unset "$v"; \
      done; \
      if [ -s /run/secrets/sentry_auth_token ]; then \
        export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)" SENTRY_RELEASE="$GIT_SHA"; \
      fi; \
      pnpm --filter @pen/admin build'

FROM ${NGINX_IMAGE} AS runtime
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="Pen Playground operations console" \
      org.opencontainers.image.revision="${GIT_SHA}"
COPY deploy/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
