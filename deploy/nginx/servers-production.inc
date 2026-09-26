# Production's extra server (ADR-0059): www.DOMAIN over TLS redirects to the apex. The port-80
# block in site.conf.example already answers both names. Rendered by deploy.sh.
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.DOMAIN;

    ssl_certificate /etc/letsencrypt/live/DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    return 308 https://DOMAIN$request_uri;
}
