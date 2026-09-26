# The web location, open (PEN_EDGE_GATE=0): the public product. Rendered as web.inc.
location / {
    include ENV_ROOT/nginx/proxy-web.inc;
}
