import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  defaultPolicy,
  indexInlineScriptHashes,
  inlineScriptHash,
  inlineScripts,
} from '../csp.js';

/**
 * The policy is written once, in `csp.ts`, and copied into the web container's
 * nginx config. These tests are what stop the copy from drifting: change the
 * policy or the inline theme script without regenerating the config and the
 * build fails here rather than in a browser, where the symptom would be a
 * blank board or an ad slot that never fills.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const nginxConf = readFileSync(join(repoRoot, 'deploy', 'web', 'nginx.conf'), 'utf8');
const indexHtml = readFileSync(join(here, '..', 'index.html'), 'utf8');

/** The policy string the web container actually serves. */
function servedPolicy(): string {
  const match = /set \$pen_csp "([^"]+)";/.exec(nginxConf);
  if (!match?.[1]) throw new Error('deploy/web/nginx.conf has no $pen_csp');
  return match[1];
}

describe('content security policy', () => {
  it('is the same in the generator and in the config the container serves', () => {
    expect(servedPolicy()).toBe(defaultPolicy());
  });

  it('allows the theme script that has to run before the first paint', () => {
    const scripts = inlineScripts(indexHtml);
    // One inline script, and only one: the theme flash-preventer in <head>.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('pen.theme');
    const hash = inlineScriptHash(scripts[0] ?? '');
    expect(servedPolicy()).toContain(hash);
    expect(indexInlineScriptHashes()).toEqual([hash]);
  });

  it('never falls back to unsafe-inline scripts in production', () => {
    const policy = defaultPolicy();
    const scriptSrc = /script-src ([^;]+)/.exec(policy)?.[1] ?? '';
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    // Dev relaxes script-src alone, because Vite injects inline modules and
    // evaluates them with eval; every origin stays exactly the same.
    const dev = /script-src ([^;]+)/.exec(defaultPolicy({ dev: true }))?.[1] ?? '';
    expect(dev).toContain("'unsafe-inline'");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev.replace(" 'unsafe-inline'", '').replace(" 'unsafe-eval'", '')).toBe(
      scriptSrc.replace(/ 'sha256-[^']+'/g, ''),
    );
  });

  it('ships a bundle that never needs eval', () => {
    // The dev relaxation above is Vite's, not the product's: if a dependency
    // ever brings `eval` or `new Function` into the bundle, the production
    // policy would have to be weakened — so fail here instead.
    const dist = join(here, '..', 'dist', 'assets');
    if (!existsSync(dist)) return; // nothing built in this run
    for (const file of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(join(dist, file), 'utf8');
      expect(source.includes('eval('), file).toBe(false);
      expect(source.includes('new Function('), file).toBe(false);
    }
  });

  it('shuts the doors nothing in this product opens', () => {
    const policy = defaultPolicy();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('carries every origin a session was observed to use', () => {
    const policy = defaultPolicy();
    // Measured with e2e/csp.spec.ts, which writes .pen-data/csp-origins.json.
    for (const origin of [
      'https://cdn.tldraw.com', // the board's icons, fonts and translations
      'https://fonts.gstatic.com', // the sign-in stylesheet's own font
      'https://accounts.google.com', // Google Identity Services
      'https://us.i.posthog.com', // analytics ingest
      'https://us-assets.i.posthog.com', // and its bundles
      'https://imasdk.googleapis.com', // the ad SDK (ADR-0014)
      'https://*.doubleclick.net', // the ad tag and its pixels
      'https://*.2mdn.net', // the SDK's own video client script
      'https://csi.gstatic.com', // the SDK's latency beacon
      'https://*.googlevideo.com', // the creative's video
      'https://*.gvt1.com', // and the edge `redirector.gvt1.com` sends it to
    ])
      expect(policy, origin).toContain(origin);
    // Sentry's ingest subdomain is per-organisation, so it is matched by pattern.
    expect(policy).toContain('https://*.ingest.us.sentry.io');
  });

  it('lets the ad creative reach the hosts it is actually served from', () => {
    const policy = defaultPolicy();
    // Measured on the ad path with the sample tag: the SDK pulls a second
    // script, beacons its own timings, and the creative streams from a gvt1
    // edge a redirector picks per request. Missing any one of them and the ad
    // starts and then plays nothing (see AD_RULES.progressTimeoutMs).
    expect(/script-src [^;]*https:\/\/\*\.2mdn\.net/.test(policy)).toBe(true);
    expect(/connect-src [^;]*https:\/\/csi\.gstatic\.com/.test(policy)).toBe(true);
    expect(/media-src [^;]*https:\/\/\*\.gvt1\.com/.test(policy)).toBe(true);
  });

  it('allows the SDK its own frame over http in dev only, never in production', () => {
    // The IMA SDK frames its own origin on the page's scheme, and the dev
    // server is plain http. Production is https (and upgrades anyway), so the
    // shipped policy must not carry the downgrade.
    expect(defaultPolicy()).not.toContain('http://imasdk.googleapis.com');
    expect(defaultPolicy({ dev: true })).toContain('http://imasdk.googleapis.com');
  });

  it('lets the room capture audio and play it back', () => {
    const policy = defaultPolicy();
    // The microphone AudioWorklet is a blob: URL, and replay audio is a blob too.
    expect(/worker-src [^;]*blob:/.test(policy)).toBe(true);
    expect(/media-src [^;]*blob:/.test(policy)).toBe(true);
    // The API and the room WebSocket are same-origin behind nginx.
    expect(/connect-src 'self'/.test(policy)).toBe(true);
  });

  it('leaves analytics out entirely when no host is configured', () => {
    const policy = contentSecurityPolicy({ inlineScriptHashes: [] });
    expect(policy).not.toContain('posthog');
    expect(policy).not.toContain('sentry');
  });
});
