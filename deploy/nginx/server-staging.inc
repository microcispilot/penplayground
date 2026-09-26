# Inside staging's TLS server block (ADR-0059): nothing on this host is for an index, and links
# from the path-prefix days still land. Rendered by deploy.sh; LEGACY_PREFIX is replaced.
# `X-Robots-Tag` is the half that works on assets and API responses, where a <meta> cannot
# reach; robots.txt is the half a crawler reads before it asks for anything. Locations below
# that set headers of their own repeat it, because nginx's add_header does not inherit then.
add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;

location = /robots.txt {
    default_type text/plain;
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    add_header Cache-Control "no-store" always;
    return 200 "User-agent: *\nDisallow: /\n";
}

# Staging has nothing to advertise; production's sitemap stays the only real one.
location = /sitemap.xml {
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    return 404;
}

# Links handed out while staging was served under a prefix keep working at the root.
location ^~ LEGACY_PREFIX/ {
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    rewrite ^LEGACY_PREFIX/(.*)$ /$1 permanent;
}
location = LEGACY_PREFIX {
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    return 308 https://DOMAIN/;
}
