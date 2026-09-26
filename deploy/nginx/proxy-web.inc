# The web upstream (ADR-0059): everything not handled at the edge goes to the environment's web
# container, which serves the SPA and proxies /api, /experts/portraits, /s and the /ws WebSocket
# to its own API container. Included by web.inc in each of its locations, so the open and the
# gated form of the web location forward exactly the same way. Placeholders: WEB_PORT, STACK_ID.
proxy_pass http://127.0.0.1:WEB_PORT;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $STACK_ID_connection_upgrade;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Request-ID $request_id;
# Lessons stream over one WebSocket for up to an hour; never buffer streamed responses.
proxy_buffering off;
proxy_request_buffering off;
proxy_connect_timeout 5s;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
