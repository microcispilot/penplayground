# The web location, gated (PEN_EDGE_GATE=1, ADR-0061): this environment is private.
#
# A browser without the gate cookie is sent to @gated, which asks for the shared password
# (one user in /etc/nginx/STACK.htpasswd, written by deploy.sh; the password is on the host
# in ENV_ROOT/edge.credentials, rotated with `deploy/deploy.sh ENVIRONMENT --rotate-gate`).
# The response that passes sets the cookie, and from then on every request goes straight
# through. The cookie exists because the app authenticates its own API calls with
# `Authorization: Bearer`, the header Basic auth also uses: gating /api with the password
# alone made every API call a 401 and the browser asked again on every load (2026-09-26).
# Requests from the host itself pass without either, so the deploy's own checks need no secret.
#
# Three paths never see the gate. Each is guarded by something stronger than a shared password,
# and its caller could not answer a browser's prompt:
#   /api/health           says only the environment, the release and which providers are on;
#                         the deploy and an uptime check read it from outside
#   /api/billing/webhook  Stripe signs every call (STRIPE_WEBHOOK_SECRET), and Stripe cannot log in
#   /ws/                  the lesson WebSocket demands a session token that is only issued behind
#                         the gate, and not every browser sends Basic credentials on an upgrade
location / {
    error_page 418 = @gated;
    if ($STACK_ID_gate_ok = 0) {
        return 418;
    }
    include ENV_ROOT/nginx/proxy-web.inc;
}
location @gated {
    satisfy any;
    allow 127.0.0.1;
    allow ::1;
    deny all;
    auth_basic "Pen Playground ENVIRONMENT";
    auth_basic_user_file /etc/nginx/STACK.htpasswd;
    # A location with a header of its own inherits none, so the crawler shutter is repeated;
    # the cookie is set on success only (no `always`), never on the 401 that asks.
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    add_header Set-Cookie "pen_gate=$STACK_ID_gate_token; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax";
    include ENV_ROOT/nginx/proxy-web.inc;
}
location = /api/health {
    include ENV_ROOT/nginx/proxy-web.inc;
}
location = /api/billing/webhook {
    include ENV_ROOT/nginx/proxy-web.inc;
}
location ^~ /ws/ {
    include ENV_ROOT/nginx/proxy-web.inc;
}
