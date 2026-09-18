#!/usr/bin/env bash
# Pen Playground — build both images for linux/amd64, ship them over SSH, sync the stack files and
# start (or update) the stack on prod-app-01. Idempotent: re-running with the same tag rebuilds
# from cache, skips images the host already has, rewrites the same files and re-applies compose.
#
# Usage:
#   PEN_DEPLOY_HOST=root@100.118.252.64 \
#   PEN_DEPLOY_SSH_IDENTITY_FILE=~/.ssh/id_ed25519 \
#   PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE=~/.ssh/known_hosts \
#   PEN_DOMAIN=penplayground.com \
#   deploy/deploy.sh [--tag TAG] [--skip-build] [--skip-ship] [--no-up]
#
# Optional: PEN_WITH_RENDER=0 to skip the Playwright+ffmpeg runtime (no MP4 export),
# PEN_DEPLOY_ROOT (default /srv/pen-playground), PEN_DEPLOY_EXPECTED_HOSTNAME (default
# prod-app-01), PEN_IMAGE_TAG (default: git short sha, "-dirty" when the tree has changes),
# VITE_TLDRAW_LICENSE_KEY / VITE_SENTRY_DSN / VITE_POSTHOG_TOKEN / VITE_POSTHOG_HOST /
# VITE_GOOGLE_CLIENT_ID (web build args),
# SENTRY_AUTH_TOKEN (source maps for both images are uploaded under release = git sha when set;
# passed to docker as a BuildKit secret, never as a build arg).
#
# Rollback: PEN_IMAGE_TAG=<previous tag> deploy/deploy.sh --skip-build --skip-ship
# (the host keeps every shipped tag; `docker image ls pen-playground-api` on the host lists them).
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── arguments ────────────────────────────────────────────────────────────────
SKIP_BUILD=0
SKIP_SHIP=0
NO_UP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) PEN_IMAGE_TAG="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-ship) SKIP_SHIP=1; shift ;;
    --no-up) NO_UP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── configuration ────────────────────────────────────────────────────────────
: "${PEN_DEPLOY_HOST:?set PEN_DEPLOY_HOST (e.g. root@100.118.252.64)}"
: "${PEN_DEPLOY_SSH_IDENTITY_FILE:?set PEN_DEPLOY_SSH_IDENTITY_FILE}"
: "${PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE:?set PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE}"
PEN_DOMAIN="${PEN_DOMAIN:-penplayground.com}"
PEN_DEPLOY_ROOT="${PEN_DEPLOY_ROOT:-/srv/pen-playground}"
PEN_DEPLOY_EXPECTED_HOSTNAME="${PEN_DEPLOY_EXPECTED_HOSTNAME:-prod-app-01}"
API_PORT=4200
WEB_PORT=4201

if [ -z "${PEN_IMAGE_TAG:-}" ]; then
  PEN_IMAGE_TAG="$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then PEN_IMAGE_TAG="${PEN_IMAGE_TAG}-dirty"; fi
fi
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
API_IMAGE="pen-playground-api:${PEN_IMAGE_TAG}"
WEB_IMAGE="pen-playground-web:${PEN_IMAGE_TAG}"

SSH_OPTS=(
  -i "$PEN_DEPLOY_SSH_IDENTITY_FILE"
  -o "UserKnownHostsFile=$PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE"
  -o StrictHostKeyChecking=yes
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
)
# shellcheck disable=SC2029  # remote commands are composed here on purpose, with quoted values
remote() { ssh "${SSH_OPTS[@]}" "$PEN_DEPLOY_HOST" "$@"; }
log() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
log "preflight"
for cmd in docker ssh rsync git; do
  command -v "$cmd" >/dev/null || die "missing command: $cmd"
done
[ -f "$PEN_DEPLOY_SSH_IDENTITY_FILE" ] || die "identity file not found: $PEN_DEPLOY_SSH_IDENTITY_FILE"
[ -f "$PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE" ] || die "known_hosts file not found: $PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE"
docker info >/dev/null 2>&1 || die "docker daemon is not running"
docker buildx version >/dev/null 2>&1 || die "docker buildx is required"
remote_hostname="$(remote hostname)" || die "cannot reach $PEN_DEPLOY_HOST over SSH"
[ "$remote_hostname" = "$PEN_DEPLOY_EXPECTED_HOSTNAME" ] \
  || die "remote hostname is '$remote_hostname', expected '$PEN_DEPLOY_EXPECTED_HOSTNAME' (set PEN_DEPLOY_EXPECTED_HOSTNAME to override)"
remote 'docker compose version >/dev/null && command -v rsync >/dev/null' \
  || die "the host needs docker compose v2 and rsync"
echo "host: $PEN_DEPLOY_HOST ($remote_hostname)   root: $PEN_DEPLOY_ROOT   tag: $PEN_IMAGE_TAG   domain: $PEN_DOMAIN"

# ── 1. build (linux/amd64) ───────────────────────────────────────────────────
if [ "$SKIP_BUILD" = 0 ]; then
  # Source maps: the token rides as a BuildKit secret (not in the image, not in its history).
  sentry_args=()
  if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
    sentry_args=(--secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN)
    [ -n "${SENTRY_ORG:-}" ] && sentry_args+=(--build-arg "SENTRY_ORG=$SENTRY_ORG")
    echo "  sentry: source maps will be uploaded as release $GIT_SHA"
  else
    echo "  sentry: SENTRY_AUTH_TOKEN unset, source maps stay local"
  fi

  log "building $API_IMAGE (linux/amd64)"
  docker buildx build --platform linux/amd64 --load \
    -f services/api/Dockerfile \
    --build-arg "GIT_SHA=$GIT_SHA" \
    --build-arg "WITH_RENDER=${PEN_WITH_RENDER:-1}" \
    "${sentry_args[@]}" \
    -t "$API_IMAGE" -t pen-playground-api:latest .

  log "building $WEB_IMAGE (linux/amd64)"
  web_args=(--build-arg "GIT_SHA=$GIT_SHA")
  for v in VITE_TLDRAW_LICENSE_KEY VITE_SENTRY_DSN VITE_POSTHOG_TOKEN VITE_POSTHOG_HOST VITE_GOOGLE_CLIENT_ID; do
    if [ -n "${!v:-}" ]; then web_args+=(--build-arg "$v=${!v}"); fi
  done
  docker buildx build --platform linux/amd64 --load \
    -f apps/web/Dockerfile "${web_args[@]}" "${sentry_args[@]}" \
    -t "$WEB_IMAGE" -t pen-playground-web:latest .
else
  log "skipping build (--skip-build)"
  docker image inspect "$API_IMAGE" "$WEB_IMAGE" >/dev/null 2>&1 \
    || [ "$SKIP_SHIP" = 1 ] \
    || die "images $API_IMAGE / $WEB_IMAGE are not present locally; build them or pass --skip-ship"
fi

# ── 2. ship images (docker save | ssh docker load), skipping ones the host already has ─────
if [ "$SKIP_SHIP" = 0 ]; then
  log "shipping images"
  to_ship=()
  for image in "$API_IMAGE" "$WEB_IMAGE"; do
    local_id="$(docker image inspect --format '{{.Id}}' "$image")"
    remote_id="$(remote "docker image inspect --format '{{.Id}}' '$image' 2>/dev/null || true")"
    if [ "$local_id" = "$remote_id" ]; then
      echo "  $image already on host ($local_id)"
    else
      to_ship+=("$image")
    fi
  done
  if [ "${#to_ship[@]}" -gt 0 ]; then
    echo "  sending: ${to_ship[*]}"
    docker save "${to_ship[@]}" | gzip -1 | remote 'gunzip | docker load'
  fi
else
  log "skipping ship (--skip-ship)"
fi

# ── 3. sync stack files ──────────────────────────────────────────────────────
log "syncing stack files to $PEN_DEPLOY_ROOT"
# data/ is the API's /data volume; the container runs as uid 1000 (node), so it must own it.
remote "mkdir -p '$PEN_DEPLOY_ROOT/searxng' '$PEN_DEPLOY_ROOT/nginx' '$PEN_DEPLOY_ROOT/livekit' '$PEN_DEPLOY_ROOT/data' \
  '$PEN_DEPLOY_ROOT/backup/rclone' '$PEN_DEPLOY_ROOT/backups' \
  && chown 1000:1000 '$PEN_DEPLOY_ROOT/data'"
RSYNC_SSH="ssh $(printf '%q ' "${SSH_OPTS[@]}")"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/docker-compose.yml deploy/api.env.example deploy/postgres.env.example \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/searxng/docker-compose.yml deploy/searxng/settings.yml deploy/searxng/README.md \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/searxng/"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/nginx/pen-playground.conf.example \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/nginx/"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/livekit/livekit.yaml \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/livekit/"
# The backup sidecar's scripts (docs/RUNBOOK.md → "Backups"). rclone.conf and its key
# are host-only secrets and are never synced — only the README that explains them.
rsync -rltz -e "$RSYNC_SSH" \
  deploy/backup/backup.sh deploy/backup/restore.sh deploy/backup/entrypoint.sh \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/backup/"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/backup/rclone/README.md \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/backup/rclone/"
remote "chmod 0755 '$PEN_DEPLOY_ROOT'/backup/*.sh"
# openrsync (macOS) has no --chmod; normalise modes on the host instead.
remote "find '$PEN_DEPLOY_ROOT' -maxdepth 2 -type f \\( -name '*.yml' -o -name '*.example' -o -name '*.md' \\) -exec chmod 0644 {} +"
# The vhost with DOMAIN filled in, ready to copy into /etc/nginx/sites-available.
remote "sed 's/DOMAIN/$PEN_DOMAIN/g' '$PEN_DEPLOY_ROOT/nginx/pen-playground.conf.example' > '$PEN_DEPLOY_ROOT/nginx/pen-playground.conf'"

# ── 4. secrets present? (.env is managed here; api.env / postgres.env are never generated) ──
log "checking secrets"
missing="$(remote "cd '$PEN_DEPLOY_ROOT' && for f in api.env postgres.env; do [ -s \"\$f\" ] || echo \"\$f\"; done")"
if [ -n "$missing" ]; then
  die "missing on host: $(echo "$missing" | tr '\n' ' ')— create from the .example files in $PEN_DEPLOY_ROOT (chmod 600), then re-run"
fi
# .env (compose interpolation): keep SEARXNG_SECRET and the LiveKit key pair stable, point
# LIVEKIT_URL at this domain, set PEN_IMAGE_TAG to this deploy.
remote "set -e; cd '$PEN_DEPLOY_ROOT'
  touch .env
  chmod 600 .env api.env postgres.env
  if ! grep -q '^SEARXNG_SECRET=..*' .env; then
    printf 'SEARXNG_SECRET=%s\n' \"\$(openssl rand -hex 32)\" >> .env
  fi
  if ! grep -q '^LIVEKIT_API_KEY=..*' .env; then
    printf 'LIVEKIT_API_KEY=API%s\n' \"\$(openssl rand -hex 8)\" >> .env
  fi
  if ! grep -q '^LIVEKIT_API_SECRET=..*' .env; then
    printf 'LIVEKIT_API_SECRET=%s\n' \"\$(openssl rand -base64 48 | tr -d '/+=\n')\" >> .env
  fi
  grep -v -e '^PEN_IMAGE_TAG=' -e '^LIVEKIT_URL=' .env > .env.next || true
  printf 'PEN_IMAGE_TAG=%s\n' '$PEN_IMAGE_TAG' >> .env.next
  printf 'LIVEKIT_URL=wss://%s/livekit\n' '$PEN_DOMAIN' >> .env.next
  chmod 600 .env.next
  mv .env.next .env"

# ── 5. up ────────────────────────────────────────────────────────────────────
if [ "$NO_UP" = 1 ]; then
  log "not starting the stack (--no-up)"
else
  log "docker compose up -d (tag $PEN_IMAGE_TAG)"
  # --profile backup so the nightly dump sidecar is part of every deploy; without
  # the profile compose would leave it stopped and backups would silently not run.
  remote "cd '$PEN_DEPLOY_ROOT' && docker compose --profile backup config -q \
    && docker compose --profile backup up -d --remove-orphans"

  log "waiting for health"
  ok=0
  for _ in $(seq 1 40); do
    if remote "curl -fsS http://127.0.0.1:$API_PORT/api/health >/dev/null \
               && curl -fsS http://127.0.0.1:$WEB_PORT/healthz >/dev/null \
               && curl -fsS http://127.0.0.1:$WEB_PORT/api/health >/dev/null"; then
      ok=1; break
    fi
    sleep 3
  done
  if [ "$ok" = 1 ]; then
    echo "  api: $(remote "curl -fsS http://127.0.0.1:$API_PORT/api/health")"
    echo "  web → api: ok"
  else
    remote "cd '$PEN_DEPLOY_ROOT' && docker compose ps && docker compose logs --tail=50 api web" || true
    die "stack did not become healthy; see logs above (rollback: PEN_IMAGE_TAG=<previous> $0 --skip-build --skip-ship)"
  fi
  remote "cd '$PEN_DEPLOY_ROOT' && docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"
fi

# ── 6. edge (manual, once DNS for the domain points at the host) ─────────────
cat <<STEPS

────────────────────────────────────────────────────────────────────────────
Deployed tag $PEN_IMAGE_TAG. The stack listens on 127.0.0.1:$API_PORT (api) and 127.0.0.1:$WEB_PORT (web).

Edge setup for https://$PEN_DOMAIN (run once, on the host, after the DNS A/AAAA records point here):

  # 1. vhost (port-80 block only until the certificate exists)
  cp $PEN_DEPLOY_ROOT/nginx/pen-playground.conf /etc/nginx/sites-available/pen-playground.conf
  ln -sf /etc/nginx/sites-available/pen-playground.conf /etc/nginx/sites-enabled/pen-playground.conf
  nginx -t && systemctl reload nginx

  # 2. certificate (webroot is the same one the onten vhosts use)
  mkdir -p /var/www/letsencrypt
  certbot certonly --webroot -w /var/www/letsencrypt -d $PEN_DOMAIN -d www.$PEN_DOMAIN \\
    --non-interactive --agree-tos -m <ops email>

  # 3. enable TLS and reload
  nginx -t && systemctl reload nginx
  curl -fsS https://$PEN_DOMAIN/api/health

Certbot renews automatically (systemd timer); the vhost's acme-challenge location keeps working.
────────────────────────────────────────────────────────────────────────────
STEPS
