# SearXNG for Pen Academy

A private, server-side meta-search instance. When a learner asks for a topic that is not in the
curated seeds, the API's knowledge builder (`packages/knowledge`, `SearxngSearch`) queries it to
discover licensed sources. It is free to run, so it takes precedence over Tavily/Exa whenever
`SEARXNG_URL` is set.

## How the API reaches it

- Same host, outside compose: `SEARXNG_URL=http://127.0.0.1:8080` — the container publishes port
  8080 on the loopback interface only.
- Inside the pen-academy stack (`deploy/docker-compose.yml` includes this file): the service is
  named `searxng`, so the API uses `SEARXNG_URL=http://searxng:8080`.

The API calls `GET /search?q=…&format=json&language=en&safesearch=1&categories=general` with an
8 s timeout and maps `results[].url/title/content/score`
(<https://docs.searxng.org/dev/search_api.html>).

## Files

- `docker-compose.yml` — pinned image (`searxng/searxng:2026.9.16-461f174b0`), loopback-only port,
  read-only `settings.yml` mount, dropped capabilities, health check on `/healthz`.
- `settings.yml` — `search.formats: [html, json]` (the JSON API is off by default and answers 403
  until enabled), `server.limiter: false` (single trusted client, no Valkey needed), engines kept
  to google, bing, duckduckgo, wikipedia, github, stackoverflow.
- `.env.example` — `SEARXNG_SECRET` (`openssl rand -hex 32`). The secret is read from the
  environment; it is never written into `settings.yml`.

## Run standalone

```sh
cp .env.example .env            # set SEARXNG_SECRET
docker compose up -d
curl 'http://127.0.0.1:8080/search?q=swift+optionals&format=json' | head -c 400
```

## Notes

- Never expose port 8080 publicly: with the limiter off and JSON enabled it would be an open
  search proxy. The host firewall/nginx must not forward to it.
- Google occasionally serves CAPTCHAs to server IPs; SearXNG suspends that engine for a while and
  the remaining engines keep answering. Nothing to do.
- The log line `searx.botdetection: X-Forwarded-For nor X-Real-IP header is set!` on each request
  is expected: the limiter is off and the API talks to it directly, not through a proxy.
- Upgrade by changing the image tag (tags: <https://hub.docker.com/r/searxng/searxng/tags>) and
  `docker compose up -d`.
