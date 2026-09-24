#!/usr/bin/env bash
# Give the LiveKit container the TURN certificate.
#
# LiveKit terminates TLS for TURN itself, so it needs to read the certificate and the private
# key. /etc/letsencrypt/live/<domain>/ holds symlinks into ../../archive/<domain>/, and a
# read-only mount of `live/` alone would give the container dangling links — so the two files
# are copied next to livekit.yaml instead, where compose mounts them read-only.
#
# Install it as a certbot deploy hook (runs after every successful renewal, and never when
# nothing changed):
#
#   cp /srv/pen-playground/livekit/cert-sync.sh /etc/letsencrypt/renewal-hooks/deploy/pen-livekit.sh
#   chmod 0750 /etc/letsencrypt/renewal-hooks/deploy/pen-livekit.sh
#   /etc/letsencrypt/renewal-hooks/deploy/pen-livekit.sh          # once, by hand, for the first copy
#
# Certbot sets RENEWED_LINEAGE for the certificate it just renewed; the hook exits quietly when
# that is some other certificate on this host (the Pen vhost's, an onten one).
#
# Environment (all optional):
#   PEN_TURN_DOMAIN   certificate to copy      (default turn.penplayground.com)
#   PEN_DEPLOY_ROOT   stack directory          (default /srv/pen-playground)
#   PEN_CERT_DIR      where the container reads (default $PEN_DEPLOY_ROOT/livekit/certs; the
#                     media host's stack keeps them at $PEN_DEPLOY_ROOT/certs, ADR-0043)
set -Eeuo pipefail

PEN_TURN_DOMAIN="${PEN_TURN_DOMAIN:-turn.penplayground.com}"
PEN_DEPLOY_ROOT="${PEN_DEPLOY_ROOT:-/srv/pen-playground}"
LIVE_DIR="/etc/letsencrypt/live/${PEN_TURN_DOMAIN}"
CERT_DIR="${PEN_CERT_DIR:-${PEN_DEPLOY_ROOT}/livekit/certs}"

log() { printf '%s pen-livekit cert-sync: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Called by certbot for a certificate that is not ours: nothing to do.
if [ -n "${RENEWED_LINEAGE:-}" ] && [ "$RENEWED_LINEAGE" != "$LIVE_DIR" ]; then
  exit 0
fi

[ -r "$LIVE_DIR/fullchain.pem" ] || { log "no certificate at $LIVE_DIR — run certbot for $PEN_TURN_DOMAIN first"; exit 1; }

mkdir -p "$CERT_DIR"
chmod 0750 "$CERT_DIR"

changed=0
for file in fullchain.pem privkey.pem; do
  # `cp -L` resolves the symlink into archive/; compare first so an unchanged certificate
  # never restarts the media server (a restart drops every live room).
  if ! cmp -s "$LIVE_DIR/$file" "$CERT_DIR/$file"; then
    cp -L "$LIVE_DIR/$file" "$CERT_DIR/$file.new"
    chmod 0640 "$CERT_DIR/$file.new"
    mv -f "$CERT_DIR/$file.new" "$CERT_DIR/$file"
    changed=1
  fi
done

if [ "$changed" = 0 ]; then
  log "certificate for $PEN_TURN_DOMAIN unchanged"
  exit 0
fi
log "copied the $PEN_TURN_DOMAIN certificate into $CERT_DIR"

# The container reads the files once at start, so it has to be restarted to pick up a renewal.
# Rooms reconnect on their own (ADR-0012); a renewal happens every ~60 days.
if command -v docker >/dev/null && [ -f "$PEN_DEPLOY_ROOT/docker-compose.yml" ]; then
  (cd "$PEN_DEPLOY_ROOT" && docker compose restart livekit) && log "restarted the livekit container"
else
  log "docker compose not found — restart the livekit container by hand"
fi
