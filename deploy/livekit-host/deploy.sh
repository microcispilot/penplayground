#!/usr/bin/env bash
# Deploy Pen Playground's media server to its own host (ADR-0043).
#
#   deploy/livekit-host/deploy.sh
#
# Idempotent. Copies the compose file, livekit.yaml and the certificate hook to the LiveKit
# host, makes sure the API keys there are every environment's on the app host (ADR-0059: staging
# and production each sign join tokens with a pair of their own, and the one media server
# accepts both), issues (once) or keeps the TURN certificate, and starts the server. It never
# touches the app host beyond reading the key lines of each /srv/pen-*/.env.
#
# Environment:
#   PEN_LIVEKIT_DEPLOY_HOST   ssh target of the media host          (default root@100.95.64.21)
#   PEN_DEPLOY_HOST           ssh target of the app host            (default root@100.118.252.64)
#   PEN_LIVEKIT_ROOT          stack directory on the media host     (default /srv/pen-livekit)
#   PEN_DEPLOY_ROOTS          stack directories on the app host, space-separated
#                             (default: every /srv/pen-*/ that has a .env with a key pair)
#   PEN_TURN_DOMAIN           the TURN hostname                     (default turn.penplayground.com)
#   PEN_ACME_EMAIL            certbot registration mail, first issue only
#   PEN_DEPLOY_SSH_IDENTITY_FILE / PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE   as deploy/deploy.sh
set -Eeuo pipefail

cd "$(dirname "$0")/../.."

LK_HOST="${PEN_LIVEKIT_DEPLOY_HOST:-root@100.95.64.21}"
APP_HOST="${PEN_DEPLOY_HOST:-root@100.118.252.64}"
LK_ROOT="${PEN_LIVEKIT_ROOT:-/srv/pen-livekit}"
APP_ROOTS="${PEN_DEPLOY_ROOTS:-}"
TURN_DOMAIN="${PEN_TURN_DOMAIN:-turn.penplayground.com}"

SSH_OPTS=()
[ -n "${PEN_DEPLOY_SSH_IDENTITY_FILE:-}" ] && SSH_OPTS+=(-i "$PEN_DEPLOY_SSH_IDENTITY_FILE")
[ -n "${PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE:-}" ] && SSH_OPTS+=(-o "UserKnownHostsFile=$PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE")
SSH_OPTS+=(-o ConnectTimeout=20)

log() { printf '\033[1;34m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
lk() { ssh "${SSH_OPTS[@]}" "$LK_HOST" "$@"; }
app() { ssh "${SSH_OPTS[@]}" "$APP_HOST" "$@"; }

for f in deploy/livekit-host/docker-compose.yml deploy/livekit/livekit.yaml deploy/livekit/cert-sync.sh; do
  [ -f "$f" ] || die "missing $f (run from the repository root)"
done

log "files → $LK_HOST:$LK_ROOT"
lk "mkdir -p '$LK_ROOT/certs' && chmod 0750 '$LK_ROOT/certs'"
scp -q "${SSH_OPTS[@]}" deploy/livekit-host/docker-compose.yml deploy/livekit/livekit.yaml deploy/livekit/cert-sync.sh "$LK_HOST:$LK_ROOT/"
lk "chmod 0750 '$LK_ROOT/cert-sync.sh'"

# Each environment's API signs its join tokens with its own pair and the media server verifies
# them all: the secrets exist in two places, so the media host is never given a value of its
# own. LIVEKIT_KEYS is a YAML map (livekit-server yaml-unmarshals the variable), one line.
log "api keys: every environment's on the app host"
if [ -z "$APP_ROOTS" ]; then
  APP_ROOTS="$(app "for d in /srv/pen-*/; do [ -s \"\$d.env\" ] && grep -q '^LIVEKIT_API_KEY=..*' \"\$d.env\" && printf '%s ' \"\${d%/}\"; done")"
fi
[ -n "$APP_ROOTS" ] || die "no /srv/pen-*/.env with a LIVEKIT_API_KEY on $APP_HOST; deploy an environment first"
pairs=""
for root in $APP_ROOTS; do
  key="$(app "sed -n 's/^LIVEKIT_API_KEY=//p' '$root/.env' | tail -1")"
  secret="$(app "sed -n 's/^LIVEKIT_API_SECRET=//p' '$root/.env' | tail -1")"
  [ -n "$key" ] && [ -n "$secret" ] || die "LIVEKIT_API_KEY / LIVEKIT_API_SECRET not both set in $APP_HOST:$root/.env"
  case "$key$secret" in *[,:{}\"\']*) die "a LiveKit key or secret in $root/.env carries a YAML delimiter" ;; esac
  pairs="${pairs:+$pairs, }$key: $secret"
  echo "  $root → $key"
done
printf 'LIVEKIT_KEYS={%s}\n' "$pairs" | lk "umask 077 && cat > '$LK_ROOT/.env'"

# The certificate. Issued here, standalone, on port 80 of whichever address the TURN name
# resolves to — the floating address, once it has moved to this host. The deploy hook copies the
# files beside livekit.yaml and restarts the container on every renewal.
log "certificate for $TURN_DOMAIN"
# certbot runs deploy hooks with no environment of ours, so the hook it gets is a two-line
# wrapper that names this stack's directories and hands over to the shared cert-sync.sh.
lk "set -e
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/usr/bin/env bash\n# Pen media host (ADR-0043): written by deploy/livekit-host/deploy.sh\nPEN_DEPLOY_ROOT=%s PEN_CERT_DIR=%s/certs PEN_TURN_DOMAIN=%s exec %s/cert-sync.sh \"\$@\"\n' '$LK_ROOT' '$LK_ROOT' '$TURN_DOMAIN' '$LK_ROOT' > /etc/letsencrypt/renewal-hooks/deploy/pen-livekit.sh
  chmod 0750 /etc/letsencrypt/renewal-hooks/deploy/pen-livekit.sh
  rm -rf '$LK_ROOT/livekit'
  if [ ! -r /etc/letsencrypt/live/$TURN_DOMAIN/fullchain.pem ]; then
    # Fails while the TURN address still points elsewhere (the first run, before the floating
    # address has moved): then the files already in certs/ — copied from the previous host —
    # carry the server until the next run issues its own.
    certbot certonly --standalone --non-interactive --agree-tos ${PEN_ACME_EMAIL:+-m $PEN_ACME_EMAIL} ${PEN_ACME_EMAIL:---register-unsafely-without-email} -d '$TURN_DOMAIN' \
      || echo 'certbot: could not issue yet (is $TURN_DOMAIN pointing at this host?) — using the certificate files already in $LK_ROOT/certs'
  fi
  /etc/letsencrypt/renewal-hooks/deploy/pen-livekit.sh || true
  [ -r '$LK_ROOT/certs/fullchain.pem' ] && [ -r '$LK_ROOT/certs/privkey.pem' ]" \
  || die "no TURN certificate on the media host at all: put fullchain.pem and privkey.pem in $LK_ROOT/certs, or point $TURN_DOMAIN here and re-run"

log "docker compose up"
lk "cd '$LK_ROOT' && docker compose config -q && docker compose up -d --remove-orphans"

log "waiting for the media server"
for _ in $(seq 1 30); do
  if lk "curl -fsS -m 2 http://127.0.0.1:7880/ >/dev/null 2>&1"; then break; fi
  sleep 1
done
lk "curl -fsS -m 2 http://127.0.0.1:7880/" >/dev/null || die "LiveKit did not answer on 7880; see: ssh $LK_HOST 'cd $LK_ROOT && docker compose logs --tail=50'"
lk "cd '$LK_ROOT' && docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'"
log "media server up on $LK_HOST"
