#!/usr/bin/env bash
# Serve the web app under a URL path prefix, the way the test host does — locally, in the real
# nginx image, so the whole prefixed deployment can be driven by Playwright before it is deployed.
#
#   apps/web/scripts/base-path-rig.sh            # build + serve on http://127.0.0.1:5201/testingxyzbdc/
#   PEN_BASE_PATH=/foo PEN_E2E_BASE_PORT=5300 apps/web/scripts/base-path-rig.sh
#
# It runs in the foreground and tears the container down on exit, which is what
# playwright.basepath.config.ts wants from a `webServer` command. The API is NOT started here —
# that is the config's other webServer entry (or `pnpm --filter @pen/api start` with PEN_PORT).
#
# Two tiers, the same two the production stack has:
#
#   :80    the edge — the shape of deploy/nginx/pen-playground-test.conf.example minus TLS:
#          it strips the prefix and sends /api and /ws straight to the API.
#   :8080  the web container — deploy/web/nginx.conf itself, read from the repository, with only
#          its upstream repointed at the API on the Docker host (which also removes the need for
#          Docker's embedded resolver). The CSP, the SPA fallback, the asset caching and the
#          /s and /experts/portraits routes are the real ones.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

BASE_PATH="${PEN_BASE_PATH:-/testingxyzbdc}"
BASE="/${BASE_PATH#/}"; BASE="${BASE%/}"
PORT="${PEN_E2E_BASE_PORT:-5201}"
API_PORT="${PEN_API_PORT:-4041}"
NAME="${PEN_E2E_RIG_NAME:-pen-base-path-rig}"
IMAGE="${PEN_E2E_NGINX_IMAGE:-nginx:1.30-alpine}"
SKIP_BUILD="${PEN_E2E_RIG_SKIP_BUILD:-0}"

command -v docker >/dev/null || { echo "base-path-rig: docker is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "base-path-rig: the docker daemon is not running" >&2; exit 1; }

# The API runs on the Docker host. `--add-host penhost:host-gateway` resolves to BOTH an IPv4 and
# an IPv6 address on Docker Desktop, and nginx then tries the (unroutable) IPv6 one first on every
# connection: the request still succeeds on the retry, but the error log fills with noise that
# reads exactly like a real upstream failure. Resolve the IPv4 once, up front, and use it outright.
HOST_IP="${PEN_E2E_RIG_HOST_IP:-}"
if [ -z "$HOST_IP" ]; then
  HOST_IP="$(docker run --rm --add-host penhost:host-gateway "$IMAGE" \
    sh -c 'grep -m1 -E "^[0-9.]+[[:space:]]+penhost" /etc/hosts | cut -f1' | tr -d '\r\n')"
fi
[ -n "$HOST_IP" ] || { echo "base-path-rig: could not resolve the Docker host address" >&2; exit 1; }

WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ── 1. the bundle, with the prefix baked in ──────────────────────────────────
if [ "$SKIP_BUILD" = 0 ]; then
  echo "base-path-rig: building @pen/web with PEN_BASE_PATH=$BASE"
  PEN_BASE_PATH="$BASE" pnpm --filter @pen/web build >/dev/null
fi
grep -q "\"$BASE/assets/" apps/web/dist/index.html \
  || { echo "base-path-rig: apps/web/dist was not built with base $BASE" >&2; exit 1; }

# ── 2. the two tiers ─────────────────────────────────────────────────────────
{
  cat <<EDGE
# The edge, from deploy/nginx/pen-playground-test.conf.example (TLS terminated by the host there).
map \$http_upgrade \$pen_test_connection_upgrade {
    default upgrade;
    ""      close;
}
upstream pen_api { server ${HOST_IP}:${API_PORT}; }

server {
    listen 80 default_server;
    server_name _;
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    client_max_body_size 10m;

    location = /robots.txt {
        default_type text/plain;
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
        add_header Cache-Control "no-store" always;
        return 200 "User-agent: *\\nDisallow: /\\n";
    }

    # \$http_host keeps the port; the deployed vhost names its domain outright.
    location = /            { return 308 http://\$http_host${BASE}/; }
    location = ${BASE}      { return 308 http://\$http_host${BASE}/; }

    location ^~ ${BASE}/api/ {
        proxy_pass http://pen_api/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Request-ID \$request_id;
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location ^~ ${BASE}/ws/ {
        proxy_pass http://pen_api/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$pen_test_connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location ^~ ${BASE}/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$pen_test_connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Request-ID \$request_id;
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
        return 404;
    }
}

# The web container itself, from deploy/web/nginx.conf:
EDGE
  # Three substitutions and nothing else: the `api` service becomes the host process, and the
  # variable upstream (which needed Docker's resolver) becomes a literal one.
  # shellcheck disable=SC2016  # $api is nginx's variable, matched literally, not this shell's
  sed -e '/^resolver 127\.0\.0\.11/d' \
      -e '/set \$api http:\/\/api:4000;/d' \
      -e 's|proxy_pass \$api;|proxy_pass http://pen_api;|' \
      -e 's|^    listen 80;$|    listen 127.0.0.1:8080;|' \
      deploy/web/nginx.conf
} > "$WORK/default.conf"

# shellcheck disable=SC2016  # likewise: the literal string nginx would have used
if grep -q '\$api' "$WORK/default.conf"; then
  echo "base-path-rig: the \$api variable survived the rewrite of deploy/web/nginx.conf" >&2
  exit 1
fi

# ── 3. the real nginx image ──────────────────────────────────────────────────
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:80" \
  -v "$WORK/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$REPO_ROOT/apps/web/dist:/usr/share/nginx/html:ro" \
  "$IMAGE" >/dev/null
docker exec "$NAME" nginx -t

for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}${BASE}/"; then break; fi
  sleep 0.25
done
echo "base-path-rig: serving http://127.0.0.1:${PORT}${BASE}/  (api at ${HOST_IP}:${API_PORT})"

# Foreground: Playwright kills this process when the run ends, and the trap removes the container.
docker logs -f "$NAME"
