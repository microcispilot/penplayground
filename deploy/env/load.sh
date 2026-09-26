# shellcheck shell=bash
# Load one environment's identity (deploy/env/<name>.conf) into the shell, with the values
# derived from it (ADR-0059). Sourced by deploy/deploy.sh and deploy/nginx/render.sh, so the
# vhost a test renders is the vhost a deploy installs.
#
#   source deploy/env/load.sh
#   load_env staging        # sets PEN_*, STACK_ID, SERVER_NAMES_EXTRA, LIVEKIT_UPSTREAM
#
# Only KEY=VALUE lines are honoured, and the file is authoritative: an environment's identity
# is not something a shell variable may nudge.
load_env() {
  local name="$1" file="deploy/env/$1.conf" key value required
  [ -f "$file" ] || { echo "missing $file" >&2; return 1; }
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    [[ "$key" =~ ^PEN_[A-Z_]+$ ]] || { echo "$file: '$key' is not a PEN_* setting" >&2; return 1; }
    printf -v "$key" '%s' "$value"
  done < "$file"
  for required in PEN_ENVIRONMENT PEN_DOMAIN PEN_WWW PEN_STACK PEN_DEPLOY_ROOT PEN_API_PORT PEN_WEB_PORT \
    PEN_ADMIN_PORT PEN_PG_PORT PEN_SEARXNG_PORT PEN_INDEXABLE PEN_EDGE_GATE PEN_LIVEKIT_HOST \
    PEN_BACKUP_RCLONE_REMOTE; do
    [ -n "${!required:-}" ] || { echo "$file: $required is not set" >&2; return 1; }
  done
  [ "$PEN_ENVIRONMENT" = "$name" ] || { echo "$file says PEN_ENVIRONMENT=$PEN_ENVIRONMENT" >&2; return 1; }
  PEN_LEGACY_PREFIX="${PEN_LEGACY_PREFIX:-}"
  STACK_ID="${PEN_STACK//-/_}"
  SERVER_NAMES_EXTRA=""
  [ "$PEN_WWW" = 1 ] && SERVER_NAMES_EXTRA="www.$PEN_DOMAIN"
  LIVEKIT_UPSTREAM="$PEN_LIVEKIT_HOST:7880"
  return 0
}
