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
# PEN_NODE_IMAGE (default node:22-bookworm-slim — the BUILD stage must use the same libc as the
# runtime, because native modules resolve one binary per platform: an Alpine/musl build stage
# produced a @resvg/resvg-js the glibc Playwright runtime could not load, and the API died at
# startup with MODULE_NOT_FOUND. That rasteriser is gone (ADR-0022) and `sharp` is in its place,
# which resolves @img/sharp-linux-x64 against glibc and @img/sharp-linuxmusl-x64 against musl —
# so the rule is the same rule, and the same mismatch would break it the same way),
# PEN_DEPLOY_ROOT (default /srv/pen-playground), PEN_DEPLOY_EXPECTED_HOSTNAME (default
# prod-app-01), PEN_IMAGE_TAG (default: git short sha, "-dirty" when the tree has changes),
# VITE_TLDRAW_LICENSE_KEY / VITE_SENTRY_DSN / VITE_POSTHOG_TOKEN / VITE_POSTHOG_HOST /
# VITE_GOOGLE_CLIENT_ID (web build args),
# POSTHOG_PROJECT_TOKEN / POSTHOG_HOST / SENTRY_DSN (written into the host's api.env when set, so
# the API reports to the same PostHog project the dashboards read and the Sentry project the
# alerts watch),
# GOOGLE_CLIENT_ID (written into the host's api.env; sign-in needs both halves — see below),
# PEN_TYPESAFE_API_KEY (likewise; with it intent goes straight to TypeSafe, without it the
#                       room falls back to the session model and only a log line says so),
# PEN_SMTP_HOST / _PORT / _USERNAME / _PASSWORD / _FROM (likewise; without them sign-up
#                       answers 503 and no account can be created),
#
# Serving the app under a path prefix instead of the root of its host — the test deployment:
#   PEN_VHOST=test                               which vhost to render: "prod" (default) or "test"
#   PEN_BASE_PATH=/testingxyzbdc                 baked into the web image at build time (Vite base)
#   PEN_PUBLIC_URL=https://HOST/testingxyzbdc    written into the host's api.env
#   PEN_API_URL=https://HOST/testingxyzbdc       likewise (og:image and MP4 download URLs)
# Example:
#   PEN_VHOST=test PEN_DOMAIN=sdjust.penplayground.com PEN_BASE_PATH=/testingxyzbdc \
#   PEN_PUBLIC_URL=https://sdjust.penplayground.com/testingxyzbdc \
#   PEN_API_URL=https://sdjust.penplayground.com/testingxyzbdc \
#   PEN_DEPLOY_HOST=... deploy/deploy.sh
# All four are unset by default, which is exactly today's behaviour: the root deployment, the
# production vhost, and a web image whose base is "/".
#
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
    # The whole header comment, however long it grows — up to `set -Eeuo pipefail`.
    -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 0 ;;
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

# Which edge vhost this deploy renders, and where the app sits on it.
PEN_VHOST="${PEN_VHOST:-prod}"
case "$PEN_VHOST" in
  prod|test) ;;
  *) echo "PEN_VHOST must be 'prod' or 'test' (got '$PEN_VHOST')" >&2; exit 2 ;;
esac
# "/testingxyzbdc" -> prefix "/testingxyzbdc", bare name "testingxyzbdc" (what the test vhost
# template spells). Empty means the root, which is every default in this script.
PEN_BASE_PATH="${PEN_BASE_PATH:-}"
BASE_PREFIX=""
BASE_NAME=""
if [ -n "$PEN_BASE_PATH" ] && [ "$PEN_BASE_PATH" != "/" ]; then
  BASE_NAME="${PEN_BASE_PATH#/}"; BASE_NAME="${BASE_NAME%/}"
  BASE_PREFIX="/$BASE_NAME"
fi
if [ "$PEN_VHOST" = "test" ] && [ -z "$BASE_PREFIX" ]; then
  echo "PEN_VHOST=test needs PEN_BASE_PATH (e.g. /testingxyzbdc)" >&2; exit 2
fi

if [ -z "${PEN_IMAGE_TAG:-}" ]; then
  PEN_IMAGE_TAG="$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then PEN_IMAGE_TAG="${PEN_IMAGE_TAG}-dirty"; fi
fi
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
API_IMAGE="pen-playground-api:${PEN_IMAGE_TAG}"
WEB_IMAGE="pen-playground-web:${PEN_IMAGE_TAG}"
# The operations console (ADR-0026) is opt-in: PEN_WITH_ADMIN=1 builds it, ships it and starts it
# under compose's `admin` profile. Off, every step below behaves exactly as it always has.
ADMIN_IMAGE="pen-playground-admin:${PEN_IMAGE_TAG}"
WITH_ADMIN="${PEN_WITH_ADMIN:-0}"

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
    --build-arg "NODE_IMAGE=${PEN_NODE_IMAGE:-node:22-bookworm-slim}" \
    "${sentry_args[@]}" \
    -t "$API_IMAGE" -t pen-playground-api:latest .

  log "building $WEB_IMAGE (linux/amd64)"
  web_args=(--build-arg "GIT_SHA=$GIT_SHA")
  for v in VITE_TLDRAW_LICENSE_KEY VITE_SENTRY_DSN VITE_POSTHOG_TOKEN VITE_POSTHOG_HOST VITE_GOOGLE_CLIENT_ID; do
    if [ -n "${!v:-}" ]; then web_args+=(--build-arg "$v=${!v}"); fi
  done
  # The base path is baked into the bundle (Vite base), so it belongs to the image, not the
  # container. Unset = "/", and the image is what it has always been.
  if [ -n "$BASE_PREFIX" ]; then
    web_args+=(--build-arg "PEN_BASE_PATH=$BASE_PREFIX")
    echo "  base path: $BASE_PREFIX (baked into $WEB_IMAGE)"
  fi
  docker buildx build --platform linux/amd64 --load \
    -f apps/web/Dockerfile "${web_args[@]}" "${sentry_args[@]}" \
    -t "$WEB_IMAGE" -t pen-playground-web:latest .

  if [ "$WITH_ADMIN" = 1 ]; then
    log "building $ADMIN_IMAGE (linux/amd64)"
    admin_args=(--build-arg "GIT_SHA=$GIT_SHA")
    for v in VITE_SENTRY_DSN VITE_GOOGLE_CLIENT_ID; do
      if [ -n "${!v:-}" ]; then admin_args+=(--build-arg "$v=${!v}"); fi
    done
    # No sentry_args: the console builds without source maps, so there is
    # nothing to upload (apps/admin/Dockerfile says why).
    docker buildx build --platform linux/amd64 --load \
      -f apps/admin/Dockerfile "${admin_args[@]}" \
      -t "$ADMIN_IMAGE" -t pen-playground-admin:latest .
  fi
else
  log "skipping build (--skip-build)"
  needed=("$API_IMAGE" "$WEB_IMAGE")
  if [ "$WITH_ADMIN" = 1 ]; then needed+=("$ADMIN_IMAGE"); fi
  docker image inspect "${needed[@]}" >/dev/null 2>&1 \
    || [ "$SKIP_SHIP" = 1 ] \
    || die "images ${needed[*]} are not all present locally; build them or pass --skip-ship"
fi

# ── 2. ship images (docker save | ssh docker load), skipping ones the host already has ─────
if [ "$SKIP_SHIP" = 0 ]; then
  log "shipping images"
  to_ship=()
  ship_list=("$API_IMAGE" "$WEB_IMAGE")
  if [ "$WITH_ADMIN" = 1 ]; then ship_list+=("$ADMIN_IMAGE"); fi
  for image in "${ship_list[@]}"; do
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
  deploy/nginx/pen-playground.conf.example deploy/nginx/pen-playground-test.conf.example \
  deploy/nginx/pen-playground-admin.conf.example \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/nginx/"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/livekit/livekit.yaml deploy/livekit/cert-sync.sh \
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

# ── backup key: install it on a host that has none ───────────────────────────
# The backup stream is the database and the learners' sessions leaving the
# machine, so the far end is pinned rather than trusted on sight: without a
# known_hosts file rclone says plainly that "no host key validation is being
# performed", which is an unauthenticated SFTP channel carrying everything we
# hold. `PEN_BACKUP_KNOWN_HOSTS_B64` carries the box's host keys, base64 of the
# whole file, exactly as the private key beside it is carried.
#
# ALL of the host's keys, not one. Pinning only the ed25519 line looked right
# and failed in production on the first nightly run — "knownhosts: key
# mismatch" — because the box offers rsa, ecdsa and ed25519, and rclone is free
# to negotiate any of them. Take every line ssh-keyscan returns:
#   ssh-keyscan -p 23 <host> | grep -v '^#' | base64
# Unset, the file is empty and rclone refuses to connect rather than falling
# back to trusting whatever answers.
# The Storage Box trusts one public key. Keeping its private half only on the
# host means a rebuilt host needs a human to mint a new key and authorise it in
# the Hetzner Console; keeping it in the workstation's .env means a fresh host
# is wired up by the next deploy instead. Base64 so the PEM is one line.
# A host that already has the key is never overwritten — rotation is deliberate
# (docs/RUNBOOK.md → "Backups"), not a side effect of deploying.
if [ -n "${PEN_BACKUP_SSH_KEY_B64:-}" ]; then
  log "backup key"
  remote "set -e
    mkdir -p /root/.ssh '$PEN_DEPLOY_ROOT/backup/rclone'
    chmod 700 /root/.ssh '$PEN_DEPLOY_ROOT/backup/rclone'
    if [ -s /root/.ssh/pen-backup ]; then
      echo '  key already on the host, left alone'
    else
      printf '%s' '$PEN_BACKUP_SSH_KEY_B64' | base64 -d > /root/.ssh/pen-backup
      chmod 600 /root/.ssh/pen-backup
      ssh-keygen -y -f /root/.ssh/pen-backup > /root/.ssh/pen-backup.pub
      echo '  installed /root/.ssh/pen-backup'
    fi
    cp -f /root/.ssh/pen-backup '$PEN_DEPLOY_ROOT/backup/rclone/pen-backup'
    chmod 600 '$PEN_DEPLOY_ROOT/backup/rclone/pen-backup'
    printf '%s' '${PEN_BACKUP_KNOWN_HOSTS_B64:-}' | base64 -d > '$PEN_DEPLOY_ROOT/backup/rclone/known_hosts' 2>/dev/null || : > '$PEN_DEPLOY_ROOT/backup/rclone/known_hosts'
    chmod 600 '$PEN_DEPLOY_ROOT/backup/rclone/known_hosts'
    printf '[hetzner]\ntype = sftp\nhost = %s\nuser = %s\nport = %s\nkey_file = /rclone/pen-backup\nknown_hosts_file = /rclone/known_hosts\nshell_type = unix\n' \
      '${PEN_BACKUP_REMOTE_HOST:-}' '${PEN_BACKUP_REMOTE_USER:-}' '${PEN_BACKUP_REMOTE_PORT:-23}' \
      > '$PEN_DEPLOY_ROOT/backup/rclone/rclone.conf'
    chmod 600 '$PEN_DEPLOY_ROOT/backup/rclone/rclone.conf'"
  # A destination with no pinned key is the one combination that fails quietly:
  # rclone refuses every connection and the nightly copy stops leaving the
  # machine, with nothing on the deploy's own output to say why. Say it here.
  if [ -n "${PEN_BACKUP_RCLONE_REMOTE:-}" ] && [ -z "${PEN_BACKUP_KNOWN_HOSTS_B64:-}" ]; then
    log "backup: PEN_BACKUP_RCLONE_REMOTE is set but PEN_BACKUP_KNOWN_HOSTS_B64 is empty"
    log "        → the off-host copy will refuse to connect; see .env.example"
  fi
  # The remote the sidecar copies to; empty means local-only backups.
  remote "cd '$PEN_DEPLOY_ROOT'
    grep -v '^PEN_BACKUP_RCLONE_REMOTE=' .env > .env.next 2>/dev/null || true
    printf 'PEN_BACKUP_RCLONE_REMOTE=%s\n' '${PEN_BACKUP_RCLONE_REMOTE:-}' >> .env.next
    chmod 600 .env.next && mv .env.next .env"
else
  log "backup key: PEN_BACKUP_SSH_KEY_B64 unset, leaving the host's own (if any)"
fi
# The TURN certificate lives here (cert-sync.sh fills it); without it the container refuses to
# start, so an empty directory is created on every deploy and the hook is left executable.
remote "mkdir -p '$PEN_DEPLOY_ROOT/livekit/certs' && chmod 0750 '$PEN_DEPLOY_ROOT/livekit/certs' \
  && chmod 0750 '$PEN_DEPLOY_ROOT/livekit/cert-sync.sh'"
# openrsync (macOS) has no --chmod; normalise modes on the host instead.
remote "find '$PEN_DEPLOY_ROOT' -maxdepth 2 -type f \\( -name '*.yml' -o -name '*.example' -o -name '*.md' \\) -exec chmod 0644 {} +"
# The vhost with its placeholders filled in, ready to copy into /etc/nginx/sites-available.
# Both templates land on the host either way; only the chosen one is rendered.
if [ "$PEN_VHOST" = "test" ]; then
  VHOST_NAME="pen-playground-test"
  remote "sed -e 's/TEST_DOMAIN/$PEN_DOMAIN/g' -e 's/BASE_PATH/$BASE_NAME/g' \
    '$PEN_DEPLOY_ROOT/nginx/pen-playground-test.conf.example' > '$PEN_DEPLOY_ROOT/nginx/$VHOST_NAME.conf'"
else
  VHOST_NAME="pen-playground"
  remote "sed 's/DOMAIN/$PEN_DOMAIN/g' '$PEN_DEPLOY_ROOT/nginx/pen-playground.conf.example' > '$PEN_DEPLOY_ROOT/nginx/$VHOST_NAME.conf'"
fi
echo "  vhost: $VHOST_NAME.conf (PEN_VHOST=$PEN_VHOST)"

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

# api.env is the host's own file and is never generated here — but the two public URLs are a
# property of the edge this script just rendered, not of the secrets, and a prefixed deployment
# is wrong without them (share links, og:image, the sitemap, MP4 download links, Stripe's
# return URLs). Set either variable and its line is rewritten in place; leave them unset — the
# default — and api.env is not touched at all.
#
# The `PEN_SMTP_*` set rides along because sign-up cannot work without it: with
# no relay configured the API still boots and everything else works, but
# `POST /api/auth/register/start` answers 503 and no account can ever be
# created. A deploy that forgot these would look completely healthy and quietly
# have no way to register a user.
#
# `PEN_TYPESAFE_API_KEY` rides along because intent classification is the one
# provider whose key decides *which endpoint* is called, not just whether it
# works: with it the room talks to TypeSafe directly (one hop fewer, ~29 % off
# the median), without it the room quietly falls back to the session model and
# nothing says so except a single log line. Leaving it out of a deploy is a
# slower product that looks healthy.
#
# `GOOGLE_CLIENT_ID` rides along for a reason learned the hard way: the web
# build takes its half of sign-in from `VITE_GOOGLE_CLIENT_ID` as a build arg,
# so setting only that ships a button the API cannot honour — it verifies the
# token the button returns against its own copy of the id. One variable set and
# the other not is the one combination that looks deployed and is not, which is
# exactly what happened here on 2026-09-18 (`/api/health` said `google:false`
# beside a rendered button). They are set together or the deploy says so.
#
# `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` ride along for the same reason,
# learned on 2026-09-23: the host's api.env carried a token that belonged to no
# project we own, so every server-side event production had ever sent went
# nowhere, while the dashboards — reading the project the workstation's token
# names — showed only development and desktop traffic. The batch endpoint
# answers 200 to a wrong token, so nothing on the host could have said so.
# `SENTRY_DSN` too, found the same day the same way: the host's DSN matched
# none of the organisation's active keys. When the operator's shell has them,
# the host gets them.
for var in PEN_PUBLIC_URL PEN_API_URL GOOGLE_CLIENT_ID PEN_TYPESAFE_API_KEY \
  POSTHOG_PROJECT_TOKEN POSTHOG_HOST SENTRY_DSN \
  PEN_SMTP_HOST PEN_SMTP_PORT PEN_SMTP_USERNAME PEN_SMTP_PASSWORD PEN_SMTP_FROM; do
  value="${!var:-}"
  [ -n "$value" ] || continue
  case "$var" in
    PEN_PUBLIC_URL|PEN_API_URL)
      case "$value" in
        http://*|https://*) ;;
        *) die "$var must be an absolute URL (got '$value')" ;;
      esac
      ;;
  esac
  log "setting $var in api.env"
  remote "set -e; cd '$PEN_DEPLOY_ROOT'
    grep -v '^$var=' api.env > api.env.next || true
    printf '%s=%s\n' '$var' '$value' >> api.env.next
    chmod 600 api.env.next
    mv api.env.next api.env"
  # A client id is a credential, not a URL: say that it was set, never what it is.
  case "$var" in
    GOOGLE_CLIENT_ID | PEN_TYPESAFE_API_KEY | PEN_SMTP_PASSWORD) echo "  $var=<set>" ;;
    *) echo "  $var=$value" ;;
  esac
done

# The half-enabled state, called out rather than shipped.
if [ -n "${VITE_GOOGLE_CLIENT_ID:-}" ] && [ -z "${GOOGLE_CLIENT_ID:-}" ]; then
  log "sign-in: VITE_GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_ID is not"
  log "         → the button renders and the API refuses the token it returns"
elif [ -z "${VITE_GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
  log "sign-in: GOOGLE_CLIENT_ID is set but VITE_GOOGLE_CLIENT_ID is not"
  log "         → the API can verify a token no button will ever produce"
fi

# ── 5. up ────────────────────────────────────────────────────────────────────
if [ "$NO_UP" = 1 ]; then
  log "not starting the stack (--no-up)"
else
  log "docker compose up -d (tag $PEN_IMAGE_TAG)"
  # --profile backup so the nightly dump sidecar is part of every deploy; without
  # the profile compose would leave it stopped and backups would silently not run.
  profiles="--profile backup"
  if [ "$WITH_ADMIN" = 1 ]; then profiles="$profiles --profile admin"; fi
  remote "cd '$PEN_DEPLOY_ROOT' && docker compose $profiles config -q \
    && docker compose $profiles up -d --remove-orphans"

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
# The production vhost also answers on www.; the test host is one name.
CERTBOT_WWW=""
if [ "$PEN_VHOST" = "prod" ]; then CERTBOT_WWW="-d www.$PEN_DOMAIN"; fi
cat <<STEPS

────────────────────────────────────────────────────────────────────────────
Deployed tag $PEN_IMAGE_TAG. The stack listens on 127.0.0.1:$API_PORT (api) and 127.0.0.1:$WEB_PORT (web).

Edge setup for https://$PEN_DOMAIN$BASE_PREFIX/ (run once, on the host, after the DNS A/AAAA records point here):

  # 1. vhost (port-80 block only until the certificate exists)
  cp $PEN_DEPLOY_ROOT/nginx/$VHOST_NAME.conf /etc/nginx/sites-available/$VHOST_NAME.conf
  ln -sf /etc/nginx/sites-available/$VHOST_NAME.conf /etc/nginx/sites-enabled/$VHOST_NAME.conf
  nginx -t && systemctl reload nginx

  # 2. certificate (webroot is the same one the onten vhosts use)
  mkdir -p /var/www/letsencrypt
  certbot certonly --webroot -w /var/www/letsencrypt -d $PEN_DOMAIN $CERTBOT_WWW \\
    --non-interactive --agree-tos -m <ops email>

  # 3. enable TLS and reload
  nginx -t && systemctl reload nginx
  curl -fsS https://$PEN_DOMAIN$BASE_PREFIX/api/health

Certbot renews automatically (systemd timer); the vhost's acme-challenge location keeps working.
────────────────────────────────────────────────────────────────────────────
STEPS
