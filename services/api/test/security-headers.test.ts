import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * The headers a browser relies on before any route code runs. Asserted through
 * `app.request` so the middleware stack is the real one, not a re-description
 * of it.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-security-headers-'));
const PUBLIC_URL = 'https://pen.example';
let services: Services;
let app: Hono;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_PUBLIC_URL: PUBLIC_URL,
    PEN_API_URL: 'https://api.pen.example',
  });
  services = await buildServices(cfg);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('security headers', () => {
  it('sends the browser-hardening set on every response', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBeTruthy();
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const permissions = res.headers.get('permissions-policy') ?? '';
    // The room needs the microphone on this origin; nothing else is granted.
    expect(permissions).toContain('microphone=(self)');
    expect(permissions).toContain('camera=()');
  });

  it('announces HSTS only for a request that actually arrived over TLS', async () => {
    const plain = await app.request('/api/health');
    expect(plain.headers.get('strict-transport-security')).toBeNull();

    const forwarded = await app.request('/api/health', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const hsts = forwarded.headers.get('strict-transport-security') ?? '';
    expect(hsts).toMatch(/max-age=\d+/);
    expect(hsts).toContain('includeSubDomains');
  });
});

describe('CORS', () => {
  const withOrigin = (origin: string) => app.request('/api/health', { headers: { origin } });

  it('echoes the origin this deployment serves', async () => {
    const res = await withOrigin(PUBLIC_URL);
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_URL);
  });

  it('refuses an origin nobody configured', async () => {
    const res = await withOrigin('https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // A refused preflight must not advertise the methods either.
    const preflight = await app.request('/api/me', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows any loopback port outside production, because the web host moves between checkouts', async () => {
    const res = await withOrigin('http://localhost:9999');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:9999');
  });

  it('leaves a request with no Origin alone: the bearer is what guards these routes', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.status).toBe(200);
  });
});
