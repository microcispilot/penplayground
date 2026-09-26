#!/usr/bin/env bash
# The edge, checked before it is installed (ADR-0059, ADR-0061): render both environments'
# vhosts exactly as deploy.sh does, assert what each must and must not contain, and have the
# nginx prod-app-01 runs (1.24, in Docker) accept the whole set side by side, as it must on the
# host. Runs in CI's docker job and from a workstation: deploy/nginx/test.sh
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fail() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
pass() { printf '  ✓ %s\n' "$*"; }
command -v docker >/dev/null || fail "docker is required (nginx -t runs in a container)"
command -v openssl >/dev/null || fail "openssl is required (a throwaway certificate per domain)"

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/sites-enabled" "$out/letsencrypt"

# ── render, as deploy.sh renders ──────────────────────────────────────────────
# shellcheck source=deploy/env/load.sh
source deploy/env/load.sh
for env in staging production; do
  load_env "$env"
  dir="$out/srv/$PEN_STACK/nginx"
  mkdir -p "$dir"
  deploy/nginx/render.sh "$env" "$dir"
  cp "$dir/$PEN_STACK.conf" "$out/sites-enabled/"
  # nginx opens the certificate at -t time; a self-signed one per name stands in.
  for domain in "$PEN_DOMAIN" $SERVER_NAMES_EXTRA; do
    mkdir -p "$out/letsencrypt/live/$domain"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
      -subj "/CN=$domain" -keyout "$out/letsencrypt/live/$domain/privkey.pem" \
      -out "$out/letsencrypt/live/$domain/fullchain.pem" >/dev/null 2>&1
  done
done
printf 'ssl_session_cache shared:le_nginx_SSL:10m;\nssl_protocols TLSv1.2 TLSv1.3;\n' > "$out/letsencrypt/options-ssl-nginx.conf"
openssl dhparam -dsaparam -out "$out/letsencrypt/ssl-dhparams.pem" 2048 >/dev/null 2>&1

# ── what each environment must say ────────────────────────────────────────────
st="$out/srv/pen-staging/nginx"; pr="$out/srv/pen-production/nginx"
grep -q 'server_name sdjust.penplayground.com;' "$st/pen-staging.conf" || fail "staging vhost does not name sdjust.penplayground.com"
grep -q 'server_name penplayground.com;' "$pr/pen-production.conf" || fail "production vhost does not name penplayground.com"
grep -q 'www.penplayground.com' "$pr/servers.inc" || fail "production has no www → apex server"
grep -q 'X-Robots-Tag "noindex' "$st/server.inc" || fail "staging is not kept out of the index"
! grep -q 'X-Robots-Tag' "$pr/server.inc" || fail "production must be indexable"
grep -q 'proxy_pass http://127.0.0.1:4201;' "$st/proxy-web.inc" || fail "staging does not forward to its web port"
grep -q 'proxy_pass http://127.0.0.1:4301;' "$pr/proxy-web.inc" || fail "production does not forward to its web port"
grep -q '\$pen_staging_connection_upgrade' "$st/proxy-web.inc" || fail "staging's upgrade map is not its own"
! grep -q 'STACK\|DOMAIN\|ENV_ROOT\|WEB_PORT\|ENVIRONMENT\|LEGACY_PREFIX\|LIVEKIT_UPSTREAM' "$st"/* "$pr"/* || fail "a placeholder survived rendering"
pass "both environments render with their own names, ports and robots policy"

# The gate (ADR-0061): staging asks for the password, production never does, and the three
# paths a stranger's machine must reach stay open on staging.
grep -q 'auth_basic "Pen Playground staging";' "$st/web.inc" || fail "staging's web location is not gated"
grep -q 'auth_basic_user_file /etc/nginx/pen-staging.htpasswd;' "$st/web.inc" || fail "staging's gate reads the wrong htpasswd"
{ grep -q 'satisfy any;' "$st/web.inc" && grep -q 'allow 127.0.0.1;' "$st/web.inc"; } || fail "the host itself must pass staging's gate"
for open in 'location = /api/health' 'location = /api/billing/webhook' 'location \^~ /ws/'; do
  grep -q "$open" "$st/web.inc" || fail "staging's gate closes $open"
done
! grep -q 'auth_basic' "$pr/web.inc" || fail "production must not be gated"
grep -q 'location / {' "$pr/web.inc" || fail "production has no web location"
pass "staging is gated with health, Stripe's webhook and the lesson socket open; production is open"

# ── nginx accepts the set ─────────────────────────────────────────────────────
cat > "$out/nginx.conf" <<'CONF'
events {}
http {
    include /etc/nginx/mime.types;
    include /etc/nginx/sites-enabled/*.conf;
}
CONF
if ! result="$(docker run --rm \
    -v "$out/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$out/sites-enabled:/etc/nginx/sites-enabled:ro" \
    -v "$out/srv:/srv:ro" \
    -v "$out/letsencrypt:/etc/letsencrypt:ro" \
    nginx:1.24 nginx -t 2>&1)"; then
  printf '%s\n' "$result" >&2
  fail "nginx rejected the rendered vhosts"
fi
pass "nginx 1.24 accepts both vhosts side by side"
echo "edge templates: ok"
