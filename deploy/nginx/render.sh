#!/usr/bin/env bash
# Render one environment's edge files from the templates in this directory (ADR-0059, ADR-0061):
#
#   deploy/nginx/render.sh <staging|production> <out-dir>
#
# Writes STACK.conf (the vhost), STACK-acme.conf (the port-80 answer while the certificate is
# being issued), servers.inc, server.inc, web.inc (the web location, open or gated) and
# proxy-web.inc (the proxy directives both forms of web.inc include). deploy.sh renders into a
# temporary directory and syncs it to <root>/nginx on the host; deploy/nginx/test.sh renders
# both environments and has nginx check them.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
# shellcheck source=deploy/env/load.sh
source deploy/env/load.sh

[ $# -eq 2 ] || { echo "usage: deploy/nginx/render.sh <staging|production> <out-dir>" >&2; exit 2; }
load_env "$1"
out="$2"
mkdir -p "$out"

render() {
  sed -e "s|SERVER_NAMES_EXTRA|$SERVER_NAMES_EXTRA|g" -e "s|DOMAIN|$PEN_DOMAIN|g" \
    -e "s|STACK_ID|$STACK_ID|g" -e "s|STACK|$PEN_STACK|g" -e "s|ENVIRONMENT|$PEN_ENVIRONMENT|g" \
    -e "s|API_PORT|$PEN_API_PORT|g" -e "s|WEB_PORT|$PEN_WEB_PORT|g" \
    -e "s|LIVEKIT_UPSTREAM|$LIVEKIT_UPSTREAM|g" -e "s|ENV_ROOT|$PEN_DEPLOY_ROOT|g" \
    -e "s|LEGACY_PREFIX|$PEN_LEGACY_PREFIX|g" "deploy/nginx/$1" > "$out/$2"
}

render site.conf.example "$PEN_STACK.conf"
render acme.conf.example "$PEN_STACK-acme.conf"
render "servers-$PEN_ENVIRONMENT.inc" servers.inc
render "server-$PEN_ENVIRONMENT.inc" server.inc
render proxy-web.inc proxy-web.inc
if [ "$PEN_EDGE_GATE" = 1 ]; then render web-gated.inc web.inc; else render web-open.inc web.inc; fi

if [ "$PEN_ENVIRONMENT" = staging ] && [ -z "$PEN_LEGACY_PREFIX" ]; then
  # No prefix to redirect from: the two locations would otherwise match "/".
  sed -i.bak '/^location ^~ \//,$d' "$out/server.inc" && rm -f "$out/server.inc.bak"
fi
# Every environment kept out of the index says so on every response; every private one is gated.
if [ "$PEN_INDEXABLE" != 1 ]; then
  grep -q 'X-Robots-Tag' "$out/server.inc" || { echo "$PEN_ENVIRONMENT is not indexable but its server.inc carries no X-Robots-Tag" >&2; exit 1; }
fi
if [ "$PEN_EDGE_GATE" = 1 ]; then
  grep -q 'auth_basic_user_file' "$out/web.inc" || { echo "$PEN_ENVIRONMENT is gated but its web.inc carries no auth_basic_user_file" >&2; exit 1; }
else
  ! grep -q 'auth_basic' "$out/web.inc" || { echo "$PEN_ENVIRONMENT is open but its web.inc carries auth_basic" >&2; exit 1; }
fi
