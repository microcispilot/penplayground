#!/bin/sh
# The `backup` service's process: install one crontab and hand over to crond.
#
# The image is postgres:18-alpine (so pg_dump/pg_restore are exactly the server's
# version — a dump taken by an older pg_dump against a newer server is refused)
# plus rclone when an off-host remote is configured.
#
# With arguments it runs them instead and exits — that is what
# `docker compose --profile backup run --rm backup /backup.sh` (and
# `/restore.sh <date>`) rely on: an entrypoint that ignored its arguments
# would silently start the scheduler and hang.
set -eu

SCHEDULE="${PEN_BACKUP_CRON:-15 3 * * *}"

install_rclone() {
  if [ -n "${PEN_BACKUP_RCLONE_REMOTE:-}" ] && ! command -v rclone >/dev/null 2>&1; then
    echo "backup: installing rclone for ${PEN_BACKUP_RCLONE_REMOTE}"
    apk add --no-cache rclone >/dev/null 2>&1 || echo "backup: rclone install failed; local only"
  fi
}

# One-off: `run --rm backup /backup.sh`, `/restore.sh 2026-09-17`, or a shell.
if [ "$#" -gt 0 ]; then
  install_rclone
  exec "$@"
fi

install_rclone

# cron gets no environment of its own: hand it the one the container was given.
# (Only the variables the scripts read, so a password never lands in a log.)
{
  echo "POSTGRES_HOST=${POSTGRES_HOST:-postgres}"
  echo "POSTGRES_USER=${POSTGRES_USER:-pen}"
  echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-}"
  echo "POSTGRES_DB=${POSTGRES_DB:-pen}"
  echo "PEN_BACKUP_KEEP_DAYS=${PEN_BACKUP_KEEP_DAYS:-14}"
  echo "PEN_BACKUP_RCLONE_REMOTE=${PEN_BACKUP_RCLONE_REMOTE:-}"
  echo "PEN_BACKUP_DATA_DIR=${PEN_BACKUP_DATA_DIR:-/data}"
  echo "RCLONE_CONFIG=${RCLONE_CONFIG:-/rclone/rclone.conf}"
  # Output goes to the container's stdout, so `docker compose logs backup`
  # shows every run — successful or not.
  echo "${SCHEDULE} /backup.sh > /proc/1/fd/1 2>/proc/1/fd/2"
} > /etc/crontabs/root
chmod 600 /etc/crontabs/root

echo "backup: scheduled '${SCHEDULE}' (UTC), keeping ${PEN_BACKUP_KEEP_DAYS:-14} days, remote='${PEN_BACKUP_RCLONE_REMOTE:-none}'"
exec crond -f -l 8
