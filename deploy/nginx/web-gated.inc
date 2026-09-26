# The web location, gated (PEN_EDGE_GATE=1, ADR-0061): this environment is private. Every
# request answers 401 until the browser sends the gate's credentials: one shared user in
# /etc/nginx/STACK.htpasswd, written by deploy.sh and readable on the host in
# ENV_ROOT/edge.credentials (rotate with `deploy/deploy.sh ENVIRONMENT --rotate-gate`).
# Requests from the host itself pass without it, so the deploy's own checks need no password.
#
# Three paths stay open. Each is guarded by something stronger than a shared password, and its
# caller could not answer a browser's prompt:
#   /api/health           says only the environment, the release and which providers are on;
#                         the deploy and an uptime check read it from outside
#   /api/billing/webhook  Stripe signs every call (STRIPE_WEBHOOK_SECRET), and Stripe cannot log in
#   /ws/                  the lesson WebSocket demands a session token that is only issued behind
#                         the gate, and not every browser sends Basic credentials on an upgrade
location / {
    satisfy any;
    allow 127.0.0.1;
    allow ::1;
    deny all;
    auth_basic "Pen Playground ENVIRONMENT";
    auth_basic_user_file /etc/nginx/STACK.htpasswd;
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
