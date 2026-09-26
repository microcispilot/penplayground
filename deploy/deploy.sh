#!/usr/bin/env bash
# Pen Playground — deploy one environment (ADR-0059): build the images for linux/amd64 (or take
# the ones staging runs), ship them, sync the stack files, write the environment's .env, start
# or update its compose stack and install its edge vhost. Idempotent: re-running with the same
# tag rebuilds from cache, skips images the host already has, rewrites the same files and
# re-applies compose.
#
# Usage:
#   deploy/deploy.sh staging                       build HEAD, ship, deploy to staging
#   deploy/deploy.sh production --promote          deploy to production exactly what staging runs
#   deploy/deploy.sh <env> --tag TAG --skip-build  redeploy an image the host already has (rollback)
#
# Environments are deploy/env/<name>.conf: domain, stack name, root, ports, robots policy, the
# media host and the backup folder. Secrets never leave the host: /<root>/api.env and
# postgres.env are the environment's own, created once from the .example files. The script
# rewrites only the lines that follow from the environment (the two public URLs) and, when the
# operator's shell has them, the provider keys listed at "api.env" below.
#
# Options:
#   --promote        production only: take PEN_IMAGE_TAG and PEN_RELEASE from staging's .env on
#                    the host, require staging to be healthy on that release, and deploy it
#                    without building or shipping. The only ordinary way into production.
#   --tag TAG        the image tag to deploy (default: git short sha, "-dirty" if the tree is)
#   --skip-build     do not build; the images must exist locally (or on the host with --skip-ship)
#   --skip-ship      do not ship; the images must exist on the host
#   --no-up          stop after writing the files (no compose up, no edge)
#   --edge           install the vhost even if this environment's site is not enabled yet: the
#                    first time a domain goes live (certbot runs if the certificate is missing).
#                    Once enabled, every later deploy refreshes the vhost on its own.
#   --rotate-gate    a gated environment (PEN_EDGE_GATE=1, ADR-0061) gets a new password; the
#                    old one stops working at the reload. Read the new one on the host in
#                    <root>/edge.credentials. It is never printed here.
#
# Connection: PEN_DEPLOY_HOST (default root@100.118.252.64), PEN_DEPLOY_SSH_IDENTITY_FILE
# (default ~/.ssh/id_ed25519), PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE (default ~/.ssh/known_hosts),
# PEN_DEPLOY_EXPECTED_HOSTNAME (default prod-app-01).
#
# Build: PEN_WITH_RENDER=0 skips the Playwright+ffmpeg runtime (no MP4 export); PEN_NODE_IMAGE
# (default node:22-bookworm-slim — the BUILD stage must use the same libc as the runtime, because
# native modules resolve one binary per platform); PEN_WITH_ADMIN=1 builds, ships and starts the
# operations console too. Web build args, passed when set: VITE_TLDRAW_LICENSE_KEY,
# VITE_SENTRY_DSN, VITE_POSTHOG_TOKEN, VITE_POSTHOG_HOST, VITE_GOOGLE_CLIENT_ID.
# SENTRY_AUTH_TOKEN / SENTRY_ORG: source maps for both images are uploaded under release =
# git sha when set (a BuildKit secret, never a build arg).
#
# api.env, when set in the shell (each is written into the environment's api.env): GOOGLE_CLIENT_ID,
# GOOGLE_CLIENT_SECRET, PEN_TYPESAFE_API_KEY, FISH_AUDIO_API_KEY, CARTESIA_API_KEY,
# POSTHOG_PROJECT_TOKEN, POSTHOG_HOST, SENTRY_DSN, PEN_SMTP_HOST/_PORT/_USERNAME/_PASSWORD/_FROM.
# Backups: PEN_BACKUP_SSH_KEY_B64, PEN_BACKUP_KNOWN_HOSTS_B64, PEN_BACKUP_REMOTE_HOST/_USER/_PORT.
# Edge: PEN_ACME_EMAIL (certbot registration, first certificate only).
#
# Rollback: deploy/deploy.sh <env> --tag <previous tag> --skip-build --skip-ship
# (the host keeps every shipped tag; `docker image ls pen-playground-api` there lists them).
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── arguments ────────────────────────────────────────────────────────────────
ENVIRONMENT=""
SKIP_BUILD=0
SKIP_SHIP=0
NO_UP=0
PROMOTE=0
EDGE=0
ROTATE_GATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    staging|production) ENVIRONMENT="$1"; shift ;;
    --tag) PEN_IMAGE_TAG="$2"; shift 2 ;;
    --promote) PROMOTE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-ship) SKIP_SHIP=1; shift ;;
    --no-up) NO_UP=1; shift ;;
    --edge) EDGE=1; shift ;;
    --rotate-gate) ROTATE_GATE=1; shift ;;
    # The whole header comment, however long it grows — up to `set -Eeuo pipefail`.
    -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ENVIRONMENT" ] || die "which environment? deploy/deploy.sh staging | production [--promote]"

# ── the environment (deploy/env/<name>.conf: identity, never secrets) ────────
# deploy/env/load.sh reads the file and derives the rest; deploy/nginx/render.sh uses the same
# loader, so a vhost checked by deploy/nginx/test.sh is the vhost installed here. The file is
# authoritative: an environment's identity is not something a shell variable may nudge. What
# the shell may add is listed in the header.
# shellcheck source=deploy/env/load.sh
source deploy/env/load.sh
load_env "$ENVIRONMENT" || die "deploy/env/$ENVIRONMENT.conf could not be loaded"
[ "$ROTATE_GATE" = 0 ] || [ "$PEN_EDGE_GATE" = 1 ] || die "$ENVIRONMENT has no gate to rotate (PEN_EDGE_GATE=0)"

# ── connection ───────────────────────────────────────────────────────────────
PEN_DEPLOY_HOST="${PEN_DEPLOY_HOST:-root@100.118.252.64}"
PEN_DEPLOY_SSH_IDENTITY_FILE="${PEN_DEPLOY_SSH_IDENTITY_FILE:-$HOME/.ssh/id_ed25519}"
PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE="${PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE:-$HOME/.ssh/known_hosts}"
PEN_DEPLOY_EXPECTED_HOSTNAME="${PEN_DEPLOY_EXPECTED_HOSTNAME:-prod-app-01}"
SSH_OPTS=(
  -i "$PEN_DEPLOY_SSH_IDENTITY_FILE"
  -o "UserKnownHostsFile=$PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE"
  -o StrictHostKeyChecking=yes
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  # Six missed keepalives (90 s), not the default three: the path to the host is a relayed
  # Tailscale link that stalls for tens of seconds under load, and a stall is not a dead peer.
  -o ServerAliveCountMax=6
)
# shellcheck disable=SC2029  # remote commands are composed here on purpose, with quoted values
remote() { ssh "${SSH_OPTS[@]}" "$PEN_DEPLOY_HOST" "$@"; }
RSYNC_SSH="ssh $(printf '%q ' "${SSH_OPTS[@]}")"

# ── preflight ────────────────────────────────────────────────────────────────
log "preflight ($ENVIRONMENT)"
for cmd in docker ssh rsync git zstd; do
  command -v "$cmd" >/dev/null || die "missing command: $cmd"
done
[ -f "$PEN_DEPLOY_SSH_IDENTITY_FILE" ] || die "identity file not found: $PEN_DEPLOY_SSH_IDENTITY_FILE"
[ -f "$PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE" ] || die "known_hosts file not found: $PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE"
if [ "$SKIP_BUILD" = 0 ] || [ "$SKIP_SHIP" = 0 ]; then
  docker info >/dev/null 2>&1 || die "docker daemon is not running"
fi
[ "$SKIP_BUILD" = 1 ] || docker buildx version >/dev/null 2>&1 || die "docker buildx is required"
remote_hostname="$(remote hostname)" || die "cannot reach $PEN_DEPLOY_HOST over SSH"
[ "$remote_hostname" = "$PEN_DEPLOY_EXPECTED_HOSTNAME" ] \
  || die "remote hostname is '$remote_hostname', expected '$PEN_DEPLOY_EXPECTED_HOSTNAME' (set PEN_DEPLOY_EXPECTED_HOSTNAME to override)"
remote 'docker compose version >/dev/null && command -v rsync >/dev/null && command -v zstd >/dev/null' \
  || die "the host needs docker compose v2, rsync and zstd"

# ── what is deployed: the tag and the commit ─────────────────────────────────
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$PROMOTE" = 1 ]; then
  [ "$ENVIRONMENT" = production ] || die "--promote is how production takes what staging runs; staging is deployed from a build"
  [ -z "${PEN_IMAGE_TAG:-}" ] || die "--promote and --tag are two different answers to 'which image'; pass one"
  # Staging's own record of what it runs, and its word that it is healthy on it.
  staging_env="$(remote "cat /srv/pen-staging/.env 2>/dev/null")" || die "staging has no .env on the host; deploy staging first"
  PEN_IMAGE_TAG="$(printf '%s\n' "$staging_env" | sed -n 's/^PEN_IMAGE_TAG=//p' | tail -1)"
  GIT_SHA="$(printf '%s\n' "$staging_env" | sed -n 's/^PEN_RELEASE=//p' | tail -1)"
  staging_port="$(sed -n 's/^PEN_API_PORT=//p' deploy/env/staging.conf)"
  [ -n "$PEN_IMAGE_TAG" ] && [ -n "$GIT_SHA" ] || die "staging's .env names no PEN_IMAGE_TAG / PEN_RELEASE; deploy staging first"
  staging_health="$(remote "curl -fsS -m 5 http://127.0.0.1:$staging_port/api/health")" || die "staging is not answering on :$staging_port; promote nothing"
  printf '%s' "$staging_health" | grep -q "\"release\":\"$GIT_SHA\"" \
    || die "staging is running a different release than its .env says ($GIT_SHA); deploy staging again first"
  printf '%s' "$staging_health" | grep -q '"environment":"staging"' || die "the process on :$staging_port does not call itself staging"
  SKIP_BUILD=1
  SKIP_SHIP=1
  echo "  promoting staging's $PEN_IMAGE_TAG ($GIT_SHA)"
elif [ "$ENVIRONMENT" = production ]; then
  [ -n "${PEN_IMAGE_TAG:-}" ] || die "production is deployed with --promote (what staging runs) or, for a rollback, --tag <a tag the host has> --skip-build --skip-ship"
fi
if [ -z "${PEN_IMAGE_TAG:-}" ]; then
  PEN_IMAGE_TAG="$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then PEN_IMAGE_TAG="${PEN_IMAGE_TAG}-dirty"; fi
fi
API_IMAGE="pen-playground-api:${PEN_IMAGE_TAG}"
WEB_IMAGE="pen-playground-web:${PEN_IMAGE_TAG}"
ADMIN_IMAGE="pen-playground-admin:${PEN_IMAGE_TAG}"
WITH_ADMIN="${PEN_WITH_ADMIN:-0}"
echo "host: $PEN_DEPLOY_HOST ($remote_hostname)   env: $ENVIRONMENT   stack: $PEN_STACK   root: $PEN_DEPLOY_ROOT"
echo "tag: $PEN_IMAGE_TAG   release: $GIT_SHA   domain: https://$PEN_DOMAIN   ports: api $PEN_API_PORT / web $PEN_WEB_PORT"

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

  # One web image for every environment: the base is "/", and the environment's name is
  # stamped into the app shell by the container's nginx at start (deploy/web/nginx.conf).
  log "building $WEB_IMAGE (linux/amd64)"
  web_args=(--build-arg "GIT_SHA=$GIT_SHA")
  for v in VITE_TLDRAW_LICENSE_KEY VITE_SENTRY_DSN VITE_POSTHOG_TOKEN VITE_POSTHOG_HOST VITE_GOOGLE_CLIENT_ID; do
    if [ -n "${!v:-}" ]; then web_args+=(--build-arg "$v=${!v}"); fi
  done
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
  log "skipping build"
  if [ "$SKIP_SHIP" = 0 ]; then
    needed=("$API_IMAGE" "$WEB_IMAGE")
    if [ "$WITH_ADMIN" = 1 ]; then needed+=("$ADMIN_IMAGE"); fi
    docker image inspect "${needed[@]}" >/dev/null 2>&1 \
      || die "images ${needed[*]} are not all present locally; build them or pass --skip-ship"
  fi
fi

# ── 2. ship images the host lacks ────────────────────────────────────────────
ship_list=("$API_IMAGE" "$WEB_IMAGE")
if [ "$WITH_ADMIN" = 1 ]; then ship_list+=("$ADMIN_IMAGE"); fi
if [ "$SKIP_SHIP" = 0 ]; then
  log "shipping images"
  to_ship=()
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
    # Not a pipe. `docker save | gzip | ssh docker load` moved a 1 GB API image over a
    # relayed Tailscale link (DERP, no direct path from this network), and one stall of the
    # link killed the whole pipe with "Timeout, server not responding" and nothing kept: the
    # next attempt started from byte zero (2026-09-25). So the images are saved once to a
    # zstd file, rsync'd with --partial so an interrupted transfer *continues* on retry,
    # and loaded on the host from that file. Images are shared by both environments on the
    # host (one docker daemon), so the file lands in one place whichever environment ships.
    ship_dir="$(mktemp -d)"
    ship_name="images-${PEN_IMAGE_TAG}.tar.zst"
    ship_file="$ship_dir/$ship_name"
    docker save "${to_ship[@]}" | zstd -T0 -3 -q -o "$ship_file"
    echo "  $(du -h "$ship_file" | cut -f1) compressed"
    remote "mkdir -p /srv/pen-ships"
    attempt=1
    until rsync --partial --inplace --progress -e "$RSYNC_SSH" \
      "$ship_file" "$PEN_DEPLOY_HOST:/srv/pen-ships/"; do
      [ "$attempt" -lt 8 ] || { rm -rf "$ship_dir"; die "shipping images failed after $attempt attempts"; }
      attempt=$((attempt + 1))
      echo "  transfer interrupted; resuming (attempt $attempt)"
      sleep 5
    done
    rm -rf "$ship_dir"
    remote "set -e; cd /srv/pen-ships && zstd -dc '$ship_name' | docker load && rm -f '$ship_name'"
  fi
else
  log "skipping ship"
fi
# Whatever path the images took, they must be on the host now; say so before touching the stack.
for image in "${ship_list[@]}"; do
  remote "docker image inspect '$image' >/dev/null 2>&1" || die "$image is not on the host; ship it (or pass a tag the host has)"
done

# ── 3. sync stack files ──────────────────────────────────────────────────────
log "syncing stack files to $PEN_DEPLOY_ROOT"
# data/ is the API's /data volume; the container runs as uid 1000 (node), so it must own it.
remote "mkdir -p '$PEN_DEPLOY_ROOT/searxng' '$PEN_DEPLOY_ROOT/nginx' '$PEN_DEPLOY_ROOT/livekit' '$PEN_DEPLOY_ROOT/data' \
  '$PEN_DEPLOY_ROOT/backup/rclone' '$PEN_DEPLOY_ROOT/backups' \
  && chown 1000:1000 '$PEN_DEPLOY_ROOT/data'"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/docker-compose.yml deploy/api.env.example deploy/postgres.env.example \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/"
rsync -rltz -e "$RSYNC_SSH" \
  deploy/searxng/docker-compose.yml deploy/searxng/settings.yml deploy/searxng/README.md \
  "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/searxng/"
rsync -rltz -e "$RSYNC_SSH" \
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
# The Storage Box trusts one public key, kept at /root/.ssh/pen-backup on the
# host and copied beside each environment's rclone.conf. A host that already
# has the key is never overwritten — rotation is deliberate (docs/RUNBOOK.md →
# "Backups"), not a side effect of deploying. Both environments share the key
# and the box; each copies into its own folder (PEN_BACKUP_RCLONE_REMOTE).
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
  if [ -z "${PEN_BACKUP_KNOWN_HOSTS_B64:-}" ]; then
    log "backup: PEN_BACKUP_KNOWN_HOSTS_B64 is empty → the off-host copy will refuse to connect; see .env.example"
  fi
elif remote "[ -s /root/.ssh/pen-backup ] && [ -s '$PEN_DEPLOY_ROOT/backup/rclone/rclone.conf' ]"; then
  : # this environment already has its backup wiring
elif remote "[ -s /root/.ssh/pen-backup ] && [ -s /srv/pen-staging/backup/rclone/rclone.conf ]"; then
  # A second environment on a host that already backs one up: the same key, the same box,
  # its own folder. Copied from staging's wiring so nobody types the box's address twice.
  log "backup: wiring $ENVIRONMENT to the box staging already uses (own folder: $PEN_BACKUP_RCLONE_REMOTE)"
  remote "set -e; mkdir -p '$PEN_DEPLOY_ROOT/backup/rclone' && chmod 700 '$PEN_DEPLOY_ROOT/backup/rclone'
    cp -f /root/.ssh/pen-backup /srv/pen-staging/backup/rclone/known_hosts /srv/pen-staging/backup/rclone/rclone.conf '$PEN_DEPLOY_ROOT/backup/rclone/'
    chmod 600 '$PEN_DEPLOY_ROOT'/backup/rclone/*"
else
  log "backup key: none on the host and PEN_BACKUP_SSH_KEY_B64 unset → local backups only"
fi
# The TURN certificate lives here (cert-sync.sh fills it); without it the container refuses to
# start, so an empty directory is created on every deploy and the hook is left executable.
remote "mkdir -p '$PEN_DEPLOY_ROOT/livekit/certs' && chmod 0750 '$PEN_DEPLOY_ROOT/livekit/certs' \
  && chmod 0750 '$PEN_DEPLOY_ROOT/livekit/cert-sync.sh'"
# openrsync (macOS) has no --chmod; normalise modes on the host instead.
remote "find '$PEN_DEPLOY_ROOT' -maxdepth 2 -type f \\( -name '*.yml' -o -name '*.example' -o -name '*.md' -o -name '*.inc' \\) -exec chmod 0644 {} +"

# ── 4. render the edge for this environment ──────────────────────────────────
# The vhost and its includes, from the templates, with this environment's values: rendered here
# by deploy/nginx/render.sh (the script deploy/nginx/test.sh runs against nginx), then synced.
log "rendering vhost $PEN_STACK.conf"
rendered="$(mktemp -d)"
trap 'rm -rf "$rendered"' EXIT
deploy/nginx/render.sh "$ENVIRONMENT" "$rendered" || die "the edge templates did not render for $ENVIRONMENT"
cp deploy/nginx/gate.conf.example "$rendered/"
# The includes the installed vhost reads live here, so they are kept as a set: if nginx
# refuses the new vhost, step 7 puts the previous includes back with the previous vhost
# (a vhost restored alone once read the new includes and `nginx -t` stayed broken, 2026-09-26).
remote "rm -rf '$PEN_DEPLOY_ROOT/nginx.prev'; [ -d '$PEN_DEPLOY_ROOT/nginx' ] && cp -a '$PEN_DEPLOY_ROOT/nginx' '$PEN_DEPLOY_ROOT/nginx.prev' || true"
rsync -rltz -e "$RSYNC_SSH" "$rendered/" "$PEN_DEPLOY_HOST:$PEN_DEPLOY_ROOT/nginx/"
echo "  $(ls "$rendered" | tr '\n' ' ')→ $PEN_DEPLOY_ROOT/nginx/"

# The gate (ADR-0061): one shared user, its hash where nginx's workers can read it, the password
# where only root can, the cookie token in a config only nginx's master reads, and none of the
# three in this output. Written once, kept across deploys, replaced together on --rotate-gate
# (which also signs every remembered browser out). An open environment keeps no gate files.
gate_htpasswd="/etc/nginx/$PEN_STACK.htpasswd"
gate_conf="/etc/nginx/$PEN_STACK.gate.conf"
gate_credentials="$PEN_DEPLOY_ROOT/edge.credentials"
if [ "$PEN_EDGE_GATE" = 1 ]; then
  if [ "$ROTATE_GATE" = 1 ] || ! remote "[ -s '$gate_htpasswd' ] && [ -s '$gate_credentials' ] && [ -s '$gate_conf' ]"; then
    log "gate: writing a new password and cookie token for https://$PEN_DOMAIN"
    remote "set -e
      umask 077
      pass=\$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24)
      hash=\$(printf '%s' \"\$pass\" | openssl passwd -apr1 -stdin)
      # 128 bits; as a map key a longer one overflows nginx's default map_hash_bucket_size (64).
      token=\$(openssl rand -hex 16)
      printf 'pen:%s\n' \"\$hash\" > '$gate_htpasswd.next'
      chown root:www-data '$gate_htpasswd.next' && chmod 0640 '$gate_htpasswd.next'
      mv -f '$gate_htpasswd.next' '$gate_htpasswd'
      sed -e \"s|TOKEN|\$token|g\" -e 's|STACK_ID|$STACK_ID|g' -e 's|STACK|$PEN_STACK|g' \
        '$PEN_DEPLOY_ROOT/nginx/gate.conf.example' > '$gate_conf.next'
      chmod 0600 '$gate_conf.next' && mv -f '$gate_conf.next' '$gate_conf'
      {
        printf '# The gate on https://%s (ADR-0061). Share with whoever should see %s.\n' '$PEN_DOMAIN' '$ENVIRONMENT'
        printf '# Rotate with: deploy/deploy.sh %s --rotate-gate\n' '$ENVIRONMENT'
        printf 'user=pen\npassword=%s\n' \"\$pass\"
      } > '$gate_credentials.next'
      chmod 0600 '$gate_credentials.next' && mv -f '$gate_credentials.next' '$gate_credentials'" \
      || die "could not write the gate's password on the host"
    echo "  written: $gate_htpasswd (root:www-data 0640), $gate_conf (root 0600) and $gate_credentials (root 0600)"
  else
    echo "  gate: on; the password is kept (read it on the host: $gate_credentials; new one: --rotate-gate)"
  fi
else
  remote "rm -f '$gate_htpasswd' '$gate_conf' '$gate_credentials'"
fi

# ── 5. secrets present? (.env is managed here; api.env / postgres.env are never generated) ──
log "checking secrets"
missing="$(remote "cd '$PEN_DEPLOY_ROOT' && for f in api.env postgres.env; do [ -s \"\$f\" ] || echo \"\$f\"; done")"
if [ -n "$missing" ]; then
  die "missing on host: $(echo "$missing" | tr '\n' ' ')— create from the .example files in $PEN_DEPLOY_ROOT (chmod 600), then re-run"
fi
# .env (compose interpolation): the environment's identity and ports, this deploy's tag and
# release, the media server, the backup folder. SEARXNG_SECRET and the LiveKit key pair are
# generated once per environment and kept; the media host learns every environment's pair
# from deploy/livekit-host/deploy.sh.
remote "set -e; cd '$PEN_DEPLOY_ROOT'
  touch .env
  chmod 600 .env api.env postgres.env
  if ! grep -q '^SEARXNG_SECRET=..*' .env; then
    printf 'SEARXNG_SECRET=%s\n' \"\$(openssl rand -hex 32)\" >> .env
  fi
  if ! grep -q '^LIVEKIT_API_KEY=..*' .env; then
    printf 'LIVEKIT_API_KEY=API%s\n' \"\$(openssl rand -hex 8)\" >> .env
    echo '  new LiveKit key pair for $ENVIRONMENT: run deploy/livekit-host/deploy.sh so the media host accepts it'
  fi
  if ! grep -q '^LIVEKIT_API_SECRET=..*' .env; then
    printf 'LIVEKIT_API_SECRET=%s\n' \"\$(openssl rand -base64 48 | tr -d '/+=\n')\" >> .env
  fi
  grep -v -e '^COMPOSE_PROJECT_NAME=' -e '^PEN_ENVIRONMENT=' -e '^PEN_API_PORT=' -e '^PEN_WEB_PORT=' \
    -e '^PEN_ADMIN_PORT=' -e '^PEN_PG_PORT=' -e '^PEN_SEARXNG_PORT=' -e '^PEN_IMAGE_TAG=' -e '^PEN_RELEASE=' \
    -e '^LIVEKIT_URL=' -e '^PEN_LIVEKIT_API_URL=' -e '^PEN_BACKUP_RCLONE_REMOTE=' .env > .env.next || true
  {
    printf 'COMPOSE_PROJECT_NAME=%s\n' '$PEN_STACK'
    printf 'PEN_ENVIRONMENT=%s\n' '$PEN_ENVIRONMENT'
    printf 'PEN_API_PORT=%s\nPEN_WEB_PORT=%s\nPEN_ADMIN_PORT=%s\nPEN_PG_PORT=%s\nPEN_SEARXNG_PORT=%s\n' \
      '$PEN_API_PORT' '$PEN_WEB_PORT' '$PEN_ADMIN_PORT' '$PEN_PG_PORT' '$PEN_SEARXNG_PORT'
    printf 'PEN_IMAGE_TAG=%s\nPEN_RELEASE=%s\n' '$PEN_IMAGE_TAG' '$GIT_SHA'
    printf 'LIVEKIT_URL=wss://%s/livekit\n' '$PEN_DOMAIN'
    printf 'PEN_LIVEKIT_API_URL=http://%s:7880\n' '$PEN_LIVEKIT_HOST'
    printf 'PEN_BACKUP_RCLONE_REMOTE=%s\n' '${PEN_BACKUP_RCLONE_REMOTE}'
  } >> .env.next
  chmod 600 .env.next
  mv .env.next .env"

# api.env is the environment's own file and is never generated here. Two lines follow from the
# environment and are always written — the public URLs, which every share link, og:image, the
# sitemap, CORS and Stripe's return URLs are built from — and SENTRY_ENVIRONMENT is removed so
# the process files events under PEN_ENVIRONMENT's own name. Everything else in the list is
# written only when the operator's shell has it (why each rides along: see the header).
set_api_env() {
  remote "set -e; cd '$PEN_DEPLOY_ROOT'
    grep -v '^$1=' api.env > api.env.next || true
    printf '%s=%s\n' '$1' '$2' >> api.env.next
    chmod 600 api.env.next
    mv api.env.next api.env"
}
log "api.env: the environment's URLs"
set_api_env PEN_PUBLIC_URL "https://$PEN_DOMAIN"
set_api_env PEN_API_URL "https://$PEN_DOMAIN"
remote "set -e; cd '$PEN_DEPLOY_ROOT'; grep -v '^SENTRY_ENVIRONMENT=' api.env > api.env.next || true; chmod 600 api.env.next; mv api.env.next api.env"
echo "  PEN_PUBLIC_URL=PEN_API_URL=https://$PEN_DOMAIN   SENTRY_ENVIRONMENT=$PEN_ENVIRONMENT (from PEN_ENVIRONMENT)"
for var in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET PEN_TYPESAFE_API_KEY \
  FISH_AUDIO_API_KEY CARTESIA_API_KEY \
  POSTHOG_PROJECT_TOKEN POSTHOG_HOST SENTRY_DSN \
  PEN_SMTP_HOST PEN_SMTP_PORT PEN_SMTP_USERNAME PEN_SMTP_PASSWORD PEN_SMTP_FROM; do
  value="${!var:-}"
  [ -n "$value" ] || continue
  set_api_env "$var" "$value"
  # A key is a credential, not a URL: say that it was set, never what it is.
  case "$var" in
    POSTHOG_HOST | PEN_SMTP_HOST | PEN_SMTP_PORT | PEN_SMTP_FROM) echo "  $var=$value" ;;
    *) echo "  $var=<set>" ;;
  esac
done
# The half-enabled states, called out rather than shipped.
if [ -n "${VITE_GOOGLE_CLIENT_ID:-}" ] && [ -z "${GOOGLE_CLIENT_ID:-}" ]; then
  log "sign-in: VITE_GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_ID is not → the button renders and the API refuses its token"
elif [ -z "${VITE_GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
  log "sign-in: GOOGLE_CLIENT_ID is set but VITE_GOOGLE_CLIENT_ID is not → the API can verify a token no button produces"
fi
if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -z "${GOOGLE_CLIENT_SECRET:-}" ]; then
  log "sign-in: GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET is not → Continue with Google opens and the API refuses the code"
fi

# ── 6. up ────────────────────────────────────────────────────────────────────
if [ "$NO_UP" = 1 ]; then
  log "not starting the stack (--no-up)"
  exit 0
fi
log "docker compose up -d ($PEN_STACK, tag $PEN_IMAGE_TAG)"
# --profile backup so the nightly dump sidecar is part of every deploy; without
# the profile compose would leave it stopped and backups would silently not run.
profiles="--profile backup"
if [ "$WITH_ADMIN" = 1 ]; then profiles="$profiles --profile admin"; fi
# The media server lives on its own host (ADR-0043); a local one left from before is taken down.
remote "cd '$PEN_DEPLOY_ROOT' && docker compose --profile livekit rm -sf livekit >/dev/null 2>&1 || true"
remote "cd '$PEN_DEPLOY_ROOT' && docker compose $profiles config -q \
  && docker compose $profiles up -d --remove-orphans"

log "waiting for health"
ok=0
for _ in $(seq 1 40); do
  if remote "curl -fsS http://127.0.0.1:$PEN_API_PORT/api/health >/dev/null \
             && curl -fsS http://127.0.0.1:$PEN_WEB_PORT/healthz >/dev/null \
             && curl -fsS http://127.0.0.1:$PEN_WEB_PORT/api/health >/dev/null"; then
    ok=1; break
  fi
  sleep 3
done
if [ "$ok" != 1 ]; then
  remote "cd '$PEN_DEPLOY_ROOT' && docker compose ps && docker compose logs --tail=50 api web" || true
  die "stack did not become healthy; see logs above (rollback: $0 $ENVIRONMENT --tag <previous> --skip-build --skip-ship)"
fi
# Not just "up": the right environment, on the right release, with the web container stamping
# the same name into the shell. A stack that is healthy but calls itself something else is the
# failure this whole script exists to prevent.
health="$(remote "curl -fsS http://127.0.0.1:$PEN_API_PORT/api/health")"
printf '%s' "$health" | grep -q "\"environment\":\"$PEN_ENVIRONMENT\"" \
  || die "the API on :$PEN_API_PORT calls itself something other than $PEN_ENVIRONMENT: $health"
printf '%s' "$health" | grep -q "\"release\":\"$GIT_SHA\"" \
  || die "the API on :$PEN_API_PORT reports a different release than $GIT_SHA: $health"
web_env="$(remote "curl -fsSI http://127.0.0.1:$PEN_WEB_PORT/healthz | tr -d '\r' | sed -n 's/^[Xx]-[Pp]en-[Ee]nvironment: //p'")"
[ "$web_env" = "$PEN_ENVIRONMENT" ] || die "the web container on :$PEN_WEB_PORT stamps '$web_env', not $PEN_ENVIRONMENT"
remote "curl -fsS http://127.0.0.1:$PEN_WEB_PORT/ | grep -q 'name=\"pen-environment\" content=\"$PEN_ENVIRONMENT\"'" \
  || die "the app shell on :$PEN_WEB_PORT carries no <meta name=\"pen-environment\" content=\"$PEN_ENVIRONMENT\">"
echo "  api: $health"
echo "  web: environment $web_env, shell stamped, web → api ok"
remote "cd '$PEN_DEPLOY_ROOT' && docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"

# ── 7. edge ──────────────────────────────────────────────────────────────────
# The vhost is installed when this environment's site is already enabled (every later deploy
# refreshes it) or when --edge says this is the day it goes live. Otherwise it is left rendered
# in $PEN_DEPLOY_ROOT/nginx for a look, and the stack answers on loopback only.
site="/etc/nginx/sites-available/$PEN_STACK.conf"
enabled="/etc/nginx/sites-enabled/$PEN_STACK.conf"
if [ "$EDGE" = 1 ] || remote "[ -e '$enabled' ]"; then
  log "edge: installing $PEN_STACK.conf for https://$PEN_DOMAIN"
  if ! remote "[ -r '/etc/letsencrypt/live/$PEN_DOMAIN/fullchain.pem' ]"; then
    # No certificate yet: answer the ACME challenge on port 80 for this name, get one, then go on.
    log "edge: no certificate for $PEN_DOMAIN yet → certbot (webroot)"
    remote "set -e
      mkdir -p /var/www/letsencrypt
      cp '$PEN_DEPLOY_ROOT/nginx/$PEN_STACK-acme.conf' '/etc/nginx/sites-available/$PEN_STACK-acme.conf'
      ln -sf '/etc/nginx/sites-available/$PEN_STACK-acme.conf' '/etc/nginx/sites-enabled/$PEN_STACK-acme.conf'
      nginx -t && systemctl reload nginx
      certbot certonly --webroot -w /var/www/letsencrypt -d '$PEN_DOMAIN' ${SERVER_NAMES_EXTRA:+-d $SERVER_NAMES_EXTRA} \
        --non-interactive --agree-tos ${PEN_ACME_EMAIL:+-m $PEN_ACME_EMAIL} ${PEN_ACME_EMAIL:---register-unsafely-without-email}
      rm -f '/etc/nginx/sites-enabled/$PEN_STACK-acme.conf' '/etc/nginx/sites-available/$PEN_STACK-acme.conf'" \
      || die "certbot could not issue a certificate for $PEN_DOMAIN (does its DNS point at this host?)"
  fi
  # Install, test, reload; a config nginx rejects is put back the way it was.
  remote "set -e
    if [ -e '$site' ]; then cp -p '$site' '$site.prev'; fi
    cp '$PEN_DEPLOY_ROOT/nginx/$PEN_STACK.conf' '$site'
    ln -sf '$site' '$enabled'
    if nginx -t 2>/dev/null; then
      systemctl reload nginx
      rm -f '$site.prev'
      rm -rf '$PEN_DEPLOY_ROOT/nginx.prev'
    else
      nginx -t || true
      if [ -e '$site.prev' ]; then mv -f '$site.prev' '$site'; else rm -f '$enabled' '$site'; fi
      if [ -d '$PEN_DEPLOY_ROOT/nginx.prev' ]; then
        rm -rf '$PEN_DEPLOY_ROOT/nginx' && mv '$PEN_DEPLOY_ROOT/nginx.prev' '$PEN_DEPLOY_ROOT/nginx'
      fi
      nginx -t >/dev/null 2>&1 && echo '  the previous vhost and its includes are back, and nginx accepts them'
      exit 1
    fi" || die "nginx refused the rendered vhost; the previous one is back in place"
  # Through the edge, as the world sees it.
  edge_health="$(curl -fsS -m 10 "https://$PEN_DOMAIN/api/health" 2>/dev/null || true)"
  if printf '%s' "$edge_health" | grep -q "\"environment\":\"$PEN_ENVIRONMENT\"" \
    && printf '%s' "$edge_health" | grep -q "\"release\":\"$GIT_SHA\""; then
    echo "  https://$PEN_DOMAIN/api/health → $PEN_ENVIRONMENT @ $GIT_SHA"
  else
    die "https://$PEN_DOMAIN/api/health did not answer as $PEN_ENVIRONMENT @ $GIT_SHA: ${edge_health:-no answer}"
  fi
  # The front door, as a stranger and (for a gated environment) as someone with the password.
  front="$(curl -sSI -m 10 "https://$PEN_DOMAIN/" | tr -d '\r')"
  front_status="$(printf '%s\n' "$front" | head -1 | awk '{print $2}')"
  if [ "$PEN_EDGE_GATE" = 1 ]; then
    [ "$front_status" = 401 ] || die "the gate is not on: https://$PEN_DOMAIN/ answered $front_status, not 401"
    printf '%s\n' "$front" | grep -qi '^www-authenticate: basic' || die "https://$PEN_DOMAIN/ answered 401 without WWW-Authenticate: Basic"
    # The password never enters this process's arguments or output: curl reads it as a config line.
    gate_user="$(remote "sed -n 's/^user=//p' '$gate_credentials'")"
    gate_pass="$(remote "sed -n 's/^password=//p' '$gate_credentials'")"
    [ -n "$gate_user" ] && [ -n "$gate_pass" ] || die "$gate_credentials on the host names no user/password"
    gate_jar="$(mktemp)"
    printf 'user = "%s:%s"\n' "$gate_user" "$gate_pass" \
      | curl -fsS -m 10 -K - -c "$gate_jar" "https://$PEN_DOMAIN/" | grep -q "name=\"pen-environment\" content=\"$PEN_ENVIRONMENT\"" \
      || die "https://$PEN_DOMAIN/ did not open with the gate's password"
    unset gate_pass
    grep -q 'pen_gate' "$gate_jar" || die "the gate did not set its cookie on the response that passed"
    # Remembered: the cookie alone opens the shell, and an API call that carries the app's own
    # Authorization header is answered by the API (its 401 has no WWW-Authenticate), not by the gate.
    curl -fsS -m 10 -b "$gate_jar" "https://$PEN_DOMAIN/" | grep -q "name=\"pen-environment\" content=\"$PEN_ENVIRONMENT\"" \
      || die "the gate's cookie alone did not open https://$PEN_DOMAIN/"
    api_headers="$(curl -sSI -m 10 -b "$gate_jar" -H 'Authorization: Bearer not-a-token' "https://$PEN_DOMAIN/api/me" | tr -d '\r')"
    rm -f "$gate_jar"
    ! printf '%s\n' "$api_headers" | grep -qi '^www-authenticate: basic' \
      || die "an API call with the cookie and a Bearer token was answered by the gate, not the API: the browser would ask again"
    webhook_status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "https://$PEN_DOMAIN/api/billing/webhook")"
    [ "$webhook_status" != 401 ] || die "the gate is in front of Stripe's webhook (401); it must reach the API"
    echo "  gate: on — 401 for a stranger; the password opens the app and sets the cookie; the cookie alone opens it; /api/health and Stripe's webhook open"
  else
    [ "$front_status" = 200 ] || die "https://$PEN_DOMAIN/ answered $front_status, not 200"
  fi
  if [ "$PEN_INDEXABLE" = 1 ]; then
    curl -fsS -m 10 "https://$PEN_DOMAIN/robots.txt" | grep -q '^Allow\|^Disallow: /api' \
      && echo "  robots: indexable" || echo "  robots: WARNING, /robots.txt did not read as production's"
  else
    printf '%s\n' "$front" | grep -qi '^x-robots-tag: noindex' \
      && echo "  robots: noindex on every response" || die "https://$PEN_DOMAIN/ is missing X-Robots-Tag: noindex"
  fi
else
  log "edge: $PEN_STACK.conf rendered at $PEN_DEPLOY_ROOT/nginx/ but NOT installed (site not enabled)"
  echo "  to make https://$PEN_DOMAIN live: deploy/deploy.sh $ENVIRONMENT $([ "$PROMOTE" = 1 ] && echo --promote || echo "--tag $PEN_IMAGE_TAG --skip-build --skip-ship") --edge"
fi

log "deployed $ENVIRONMENT: $PEN_IMAGE_TAG ($GIT_SHA)"
