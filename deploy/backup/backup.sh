#!/bin/sh
# Pen Playground — one backup run: a Postgres dump and a tarball of /data, into
# /backups/<UTC date>/, with a rotation pass and an optional off-host copy.
#
# Run by the `backup` service's cron (deploy/docker-compose.yml, profile
# `backup`), and by hand for an out-of-band backup:
#
#   cd /srv/pen-playground && docker compose --profile backup run --rm backup /backup.sh
#
# Everything it needs comes from the environment (the compose service sets it):
#   POSTGRES_HOST/USER/PASSWORD/DB   the database to dump
#   PEN_BACKUP_KEEP_DAYS             rotation window (default 14)
#   PEN_BACKUP_RCLONE_REMOTE         e.g. "hetzner:pen-playground" — unset = local only
#
# Exit codes: 0 all good, 1 the backup failed (cron mails/logs it; the Sentry
# heartbeat is for the API, this one is visible in `docker compose logs backup`).
set -eu

KEEP_DAYS="${PEN_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%F)"
OUT="/backups/${STAMP}"
DATA_DIR="${PEN_BACKUP_DATA_DIR:-/data}"
started="$(date -u +%s)"

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { printf '%s backup: FAILED %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

mkdir -p "$OUT"

# ── Postgres ────────────────────────────────────────────────────────────────
# Custom format (-Fc): compressed, and restorable table-by-table with pg_restore.
# Written to a .part file first so a crashed run never leaves a half dump that
# looks restorable.
log "dumping postgres ${POSTGRES_DB:-pen} from ${POSTGRES_HOST:-postgres}"
PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
  -h "${POSTGRES_HOST:-postgres}" \
  -U "${POSTGRES_USER:-pen}" \
  -d "${POSTGRES_DB:-pen}" \
  -Fc --no-owner --no-acl \
  -f "${OUT}/postgres.dump.part" || fail "pg_dump"
mv "${OUT}/postgres.dump.part" "${OUT}/postgres.dump"

# ── /data ───────────────────────────────────────────────────────────────────
# Session ledgers, audio, exports, thumbnails and Onten packs. The TTS cache and
# rendered MP4s are derived data — excluded, because they are large and a
# restore regenerates them on demand.
if [ -d "$DATA_DIR" ]; then
  log "archiving ${DATA_DIR}"
  # busybox tar matches these with fnmatch against the stored name, and `**` is
  # not special to it — `./**/export.mp4` matched nothing and quietly archived
  # every render. Patterns here are the plain globs busybox actually honours.
  tar -czf "${OUT}/data.tar.gz.part" \
    --exclude='./tts-cache' \
    --exclude='*.mp4' \
    --exclude='*.part' \
    -C "$DATA_DIR" . || fail "tar"
  mv "${OUT}/data.tar.gz.part" "${OUT}/data.tar.gz"
else
  log "no ${DATA_DIR} to archive (skipping)"
fi

# ── manifest ────────────────────────────────────────────────────────────────
# Checksums make a restore verifiable, and the sizes are what the runbook's
# "is the backup plausible?" check reads. The manifest is written *before* the
# checksums, and the checksummed files are named explicitly: a `./*` glob on a
# second run the same day picks up the previous SHA256SUMS while the shell is
# truncating it, and every later restore then refuses a perfectly good backup.
{
  echo "date=${STAMP}"
  echo "finished=$(date -u +%FT%TZ)"
  echo "seconds=$(( $(date -u +%s) - started ))"
  echo "postgres_bytes=$(wc -c < "${OUT}/postgres.dump" 2>/dev/null || echo 0)"
  echo "data_bytes=$(wc -c < "${OUT}/data.tar.gz" 2>/dev/null || echo 0)"
} > "${OUT}/manifest.txt"
(
  cd "$OUT" || exit 1
  files=""
  for f in postgres.dump data.tar.gz manifest.txt; do
    [ -f "$f" ] && files="${files} ${f}"
  done
  # shellcheck disable=SC2086  # deliberate word splitting: a list of file names
  sha256sum $files > SHA256SUMS
)

# A dump that is suspiciously small means pg_dump "succeeded" against an empty
# or wrong database; better to fail loudly now than to discover it at restore.
bytes="$(wc -c < "${OUT}/postgres.dump")"
[ "$bytes" -gt 1000 ] || fail "postgres dump is only ${bytes} bytes"

# ── rotation ────────────────────────────────────────────────────────────────
log "rotating backups older than ${KEEP_DAYS} days"
find /backups -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -exec rm -rf {} + || true

# ── off-host copy (optional) ────────────────────────────────────────────────
# One command, because "the backup is on the same disk as the thing it backs up"
# is not a backup. Unset = local only, and that is said out loud.
if [ -n "${PEN_BACKUP_RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    log "copying to ${PEN_BACKUP_RCLONE_REMOTE}"
    rclone copy --retries 3 --transfers 2 "$OUT" "${PEN_BACKUP_RCLONE_REMOTE}/${STAMP}" \
      || fail "rclone copy"
    # Mirror the local rotation so the remote does not grow forever.
    rclone delete --min-age "${KEEP_DAYS}d" "${PEN_BACKUP_RCLONE_REMOTE}" || true
    rclone rmdirs --leave-root "${PEN_BACKUP_RCLONE_REMOTE}" || true
  else
    fail "PEN_BACKUP_RCLONE_REMOTE is set but rclone is not installed in this image"
  fi
else
  log "PEN_BACKUP_RCLONE_REMOTE unset: local copy only (see docs/RUNBOOK.md)"
fi

log "done in $(( $(date -u +%s) - started ))s → ${OUT}"
ls -la "$OUT"
