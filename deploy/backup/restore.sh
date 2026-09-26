#!/bin/sh
# Pen Playground — restore one dated backup into a STOPPED stack.
#
#   cd /srv/pen-<env>
#   docker compose stop api                       # nothing may write while we restore
#   docker compose --profile backup run --rm backup /restore.sh 2026-09-17
#   docker compose start api
#
# What it does, in order: check the archive is complete, restore Postgres
# (--clean --if-exists, so the existing schema is replaced, not merged), then
# unpack /data over the live directory. Both halves are optional — pass
# --db-only or --data-only when only one is wanted.
#
# It refuses to run while the API is reachable: restoring under a live writer
# produces a database that matches neither backup nor present.
set -eu

DATE=""
DB=1
DATA=1
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --db-only) DATA=0 ;;
    --data-only) DB=0 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) DATE="$arg" ;;
  esac
done

log() { printf '%s restore: %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { printf '%s restore: FAILED %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

[ -n "$DATE" ] || fail "usage: restore.sh <YYYY-MM-DD> [--db-only|--data-only] [--force]

available:
$(ls -1 /backups 2>/dev/null || echo '  (none)')"

SRC="/backups/${DATE}"
DATA_DIR="${PEN_BACKUP_DATA_DIR:-/data}"
[ -d "$SRC" ] || fail "no backup for ${DATE} (have: $(ls -1 /backups 2>/dev/null | tr '\n' ' '))"

# ── refuse to race the API ──────────────────────────────────────────────────
if [ "$FORCE" = 0 ]; then
  if wget -q -T 2 -O /dev/null "http://api:4000/api/health" 2>/dev/null; then
    fail "the api container is still running — 'docker compose stop api' first (or --force)"
  fi
fi

# ── verify before touching anything ─────────────────────────────────────────
if [ -f "${SRC}/SHA256SUMS" ]; then
  log "verifying checksums"
  ( cd "$SRC" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) || fail "checksum mismatch in ${SRC}"
fi

if [ "$DB" = 1 ]; then
  [ -f "${SRC}/postgres.dump" ] || fail "no postgres.dump in ${SRC}"
  log "restoring postgres ${POSTGRES_DB:-pen} from ${SRC}/postgres.dump"
  # --clean --if-exists: drop what is there, then recreate. Exit status is
  # deliberately checked loosely: pg_restore warns about absent objects on a
  # first restore, which is not a failure.
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_restore \
    -h "${POSTGRES_HOST:-postgres}" \
    -U "${POSTGRES_USER:-pen}" \
    -d "${POSTGRES_DB:-pen}" \
    --clean --if-exists --no-owner --no-acl \
    "${SRC}/postgres.dump" || log "pg_restore reported warnings (usually absent objects); continuing"
  count="$(PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -h "${POSTGRES_HOST:-postgres}" \
    -U "${POSTGRES_USER:-pen}" -d "${POSTGRES_DB:-pen}" -tAc \
    'select count(*) from sessions' 2>/dev/null || echo '?')"
  log "postgres restored (sessions rows: ${count})"
fi

if [ "$DATA" = 1 ]; then
  if [ -f "${SRC}/data.tar.gz" ]; then
    log "unpacking data.tar.gz into ${DATA_DIR}"
    mkdir -p "$DATA_DIR"
    tar -xzf "${SRC}/data.tar.gz" -C "$DATA_DIR" || fail "tar extract"
    # The API runs as uid 1000; a restore performed as root must not leave it
    # unable to write its own ledger.
    chown -R 1000:1000 "$DATA_DIR" 2>/dev/null || log "could not chown ${DATA_DIR} (not root?)"
    log "data restored"
  else
    log "no data.tar.gz in ${SRC} (skipping)"
  fi
fi

log "done — start the stack: docker compose start api"
