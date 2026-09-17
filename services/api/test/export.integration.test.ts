import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { ServerMessage } from '@pen/contracts';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  buildBlackdetectArgs,
  ExportJobs,
  ffprobePathFor,
  PlaywrightRenderer,
  parseBlackIntervals,
  planExport,
  type Renderer,
  type RenderResult,
  runFfmpeg,
} from '../src/export/index.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';

/**
 * End-to-end proof of the MP4 export: a real API (fake model, silent
 * synthesizer, PGlite in memory) teaches a short scripted session to a
 * WebSocket host, the session is ended, and the real renderer (Playwright
 * Chromium + ffmpeg) turns its ledger into an MP4 that ffprobe then inspects.
 *
 * Skipped automatically when ffmpeg or the Playwright Chromium is missing.
 */
const FFMPEG = process.env.PEN_FFMPEG_PATH ?? 'ffmpeg';
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(ffprobePathFor(FFMPEG), ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const enabled = hasFfmpeg && hasChromium && !process.env.PEN_SKIP_INTEGRATION;
/**
 * Widest recorder-vs-page clock drift we accept over a whole render before correction
 * (measured 120–170 ms over 40 s on an M-series Mac; ≈ 1% of the recording).
 */
const MAX_DRIFT_MS = 400;

const repoRoot = join(DATA_DIR, '..', '..', '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up within ${timeoutMs} ms`);
}

interface Harness {
  services: Services;
  apiUrl: string;
  webUrl: string;
  dataDir: string;
  stop(): Promise<void>;
  lastRender: RenderResult | null;
}

async function boot(): Promise<Harness> {
  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const dataDir = mkdtempSync(join(tmpdir(), 'pen-export-it-'));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_PORT: String(apiPort),
    PEN_JWT_SECRET: 'integration-secret-'.repeat(3),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_PUBLIC_URL: webUrl,
    PEN_API_URL: apiUrl,
    PEN_FFMPEG_PATH: FFMPEG,
    // The host must own the `export` entitlement.
    PEN_DEV_PLAN: 'standard',
  });
  const services = await buildServices(cfg);
  await seedPacks(services.onten, join(DATA_DIR, 'packs'));
  // The real renderer, wrapped so the test can read what the page reported.
  const harness: Harness = {
    services,
    apiUrl,
    webUrl,
    dataDir,
    lastRender: null,
    stop: async () => undefined,
  };
  const real = new PlaywrightRenderer({
    baseUrl: webUrl,
    ffmpegPath: FFMPEG,
    ledger: services.ledger,
    onEvent: () => undefined,
  });
  const renderer: Renderer = {
    render: async (input) => {
      const result = await real.render(input);
      harness.lastRender = result;
      return result;
    },
  };
  services.exports = new ExportJobs({ sessionsDir: join(dataDir, 'sessions'), renderer });
  services.renderUnavailable = null;
  const { app, rooms, injectWebSocket } = buildApp(services);
  const server = serve({ fetch: app.fetch, port: apiPort, hostname: '127.0.0.1' });
  injectWebSocket(server);

  // The web app through Vite (proxying /api and /ws to this API), on a port of its own.
  const web: ChildProcess = spawn(
    'pnpm',
    [
      '--filter',
      '@pen/web',
      'exec',
      'vite',
      '--port',
      String(webPort),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, PEN_API_PORT: String(apiPort), BROWSER: 'none', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const webLog: string[] = [];
  web.stdout?.on('data', (d: Buffer) => webLog.push(d.toString()));
  web.stderr?.on('data', (d: Buffer) => webLog.push(d.toString()));
  try {
    await Promise.all([waitFor(`${apiUrl}/api/health`, 30_000), waitFor(`${webUrl}/`, 60_000)]);
  } catch (error) {
    web.kill('SIGTERM');
    throw new Error(`${String(error)}\n${webLog.join('')}`);
  }
  harness.stop = async () => {
    services.exports.close();
    rooms.sweep(Number.MAX_SAFE_INTEGER);
    web.kill('SIGTERM');
    await new Promise<void>((r) => server.close(() => r()));
    await services.db.close();
    // PEN_EXPORT_IT_KEEP=1 leaves the rendered file behind for inspection (ffprobe, playback).
    if (process.env.PEN_EXPORT_IT_KEEP) console.warn(`[export.integration] kept ${dataDir}`);
    else rmSync(dataDir, { recursive: true, force: true });
  };
  return harness;
}

/**
 * Play the host: authenticate, create a session on the seeded topic, join the
 * room, listen until `wantSays` sentences have been fully synthesised, then
 * end. Returns the session id and what the room emitted.
 */
async function scriptedSession(
  h: Harness,
  wantSays: number,
): Promise<{ sessionId: string; token: string; completed: string[] }> {
  const auth = await fetch(`${h.apiUrl}/api/auth/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada' }),
  }).then((r) => r.json() as Promise<{ token: string }>);
  const token = auth.token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const created = await fetch(`${h.apiUrl}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  const sessionId = session.id;

  const completed: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${h.apiUrl.replace('http', 'ws')}/ws/room`);
    const timer = setTimeout(
      () => reject(new Error('session did not produce audio in time')),
      90_000,
    );
    ws.on('open', () => {
      ws.send(JSON.stringify({ kind: 'auth', token }));
      ws.send(JSON.stringify({ kind: 'join', sessionId }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // audio frames: the ledger keeps them
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.kind === 'error') {
        clearTimeout(timer);
        reject(new Error(`room error ${msg.code}: ${msg.message}`));
      }
      if (msg.kind === 'say_complete') {
        completed.push(msg.sayId);
        // No progress reports on purpose: generation stays within the first segment, keeping the export short.
        if (completed.length >= wantSays) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const ended = await fetch(`${h.apiUrl}/api/sessions/${sessionId}/end`, {
    method: 'POST',
    headers,
  });
  expect(ended.status).toBe(200);
  // `end` patches the record asynchronously after the recap; wait for endedAt.
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const rec = (await fetch(`${h.apiUrl}/api/sessions/${sessionId}`).then((r) => r.json())) as {
      session: { endedAt: number | null };
    };
    if (rec.session.endedAt !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { sessionId, token, completed };
}

interface Probe {
  streams: Array<{
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
    duration?: string;
  }>;
  format: { duration: string; size: string; format_name: string };
}

describe.skipIf(!enabled)('MP4 export (integration)', () => {
  let h: Harness;
  let exportedSessionId = '';
  beforeAll(async () => {
    h = await boot();
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('renders a scripted session into an H.264/AAC MP4 whose audio lines up with the recording', async () => {
    const { sessionId, token, completed } = await scriptedSession(h, 2);
    exportedSessionId = sessionId;
    expect(completed.length).toBeGreaterThanOrEqual(2);
    const auth = { authorization: `Bearer ${token}` };

    // What the ledger says must be spoken.
    const entries = h.services.ledger.read(sessionId);
    const plan = planExport(entries, join(h.dataDir, 'sessions', sessionId, 'audio'));
    expect(plan.says.length).toBeGreaterThanOrEqual(2);
    expect(plan.says.filter((s) => !s.estimated).length).toBeGreaterThanOrEqual(2);
    const spokenSec = plan.spokenMs / 1000;

    // Request → poll → ready (through the real routes and queue).
    const post = await fetch(`${h.apiUrl}/api/sessions/${sessionId}/export`, {
      method: 'POST',
      headers: auth,
    });
    expect(post.status).toBe(202);
    let status: {
      status: string;
      progress: number;
      error: string | null;
      downloadUrl: string | null;
      bytes: number | null;
      durationMs: number | null;
    } = await post.json();
    const seen = new Set<number>();
    const deadline = Date.now() + 300_000;
    while ((status.status === 'queued' || status.status === 'rendering') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      status = await fetch(`${h.apiUrl}/api/sessions/${sessionId}/export`, { headers: auth }).then(
        (r) => r.json(),
      );
      seen.add(status.progress);
    }
    expect(status.error).toBeNull();
    expect(status.status).toBe('ready');
    expect(seen.size).toBeGreaterThan(1); // progress moved while rendering
    const render = h.lastRender;
    expect(render).not.toBeNull();
    if (!render) return;

    // The page's timeline: one start per say, monotonic, first at (nearly) zero.
    expect(render.sayStartsMs).toHaveLength(plan.says.length);
    expect(render.sayStartsMs[0]).toBeLessThan(100);
    for (let i = 1; i < render.sayStartsMs.length; i++)
      expect(render.sayStartsMs[i]).toBeGreaterThan(render.sayStartsMs[i - 1] ?? 0);
    // Says follow one another with the ledger's durations (no dead air between them).
    for (let i = 1; i < render.sayStartsMs.length; i++) {
      const expected = (render.sayStartsMs[i - 1] ?? 0) + (plan.says[i - 1]?.durationMs ?? 0);
      expect(Math.abs((render.sayStartsMs[i] ?? 0) - expected)).toBeLessThan(80);
    }
    // Sync: the trailing curtain was found on tape, the recorder's clock drifted from the
    // page's by less than the tolerated amount, and the audio was placed on the tape clock.
    expect(render.syncDriftMs).not.toBeNull();
    expect(Math.abs(render.syncDriftMs ?? 0)).toBeLessThanOrEqual(MAX_DRIFT_MS);
    expect(render.tapeStartsMs).toHaveLength(render.sayStartsMs.length);
    const scale = (render.durationMs + (render.syncDriftMs ?? 0)) / render.durationMs;
    for (let i = 0; i < render.sayStartsMs.length; i++)
      expect(
        Math.abs((render.tapeStartsMs[i] ?? 0) - (render.sayStartsMs[i] ?? 0) * scale),
      ).toBeLessThan(1);
    expect(render.durationMs).toBeGreaterThanOrEqual(plan.spokenMs + 1000 - 50);

    // The file: streams, dimensions, codecs, duration, size.
    const output = join(h.dataDir, 'sessions', sessionId, 'export.mp4');
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(50_000);
    expect(status.bytes).toBe(statSync(output).size);
    const probe = JSON.parse(
      (
        await runFfmpeg(ffprobePathFor(FFMPEG), [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          output,
        ])
      ).stdout,
    ) as Probe;
    const video = probe.streams.filter((s) => s.codec_type === 'video');
    const audio = probe.streams.filter((s) => s.codec_type === 'audio');
    expect(video).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(video[0]?.codec_name).toBe('h264');
    expect(video[0]?.width).toBe(1280);
    expect(video[0]?.height).toBe(720);
    expect(video[0]?.pix_fmt).toBe('yuv420p');
    expect(video[0]?.r_frame_rate).toBe('30/1');
    expect(audio[0]?.codec_name).toBe('aac');
    expect(audio[0]?.sample_rate).toBe('44100');
    expect(audio[0]?.channels).toBe(2);
    expect(probe.format.format_name).toContain('mp4');
    const durationSec = Number(probe.format.duration);
    expect(durationSec).toBeGreaterThanOrEqual(spokenSec);
    expect(Math.abs(durationSec - render.durationMs / 1000)).toBeLessThan(0.25);
    expect(Number(audio[0]?.duration)).toBeGreaterThanOrEqual(spokenSec - 0.25);
    expect(Number(video[0]?.duration)).toBeGreaterThanOrEqual(spokenSec - 0.25);

    // The picture is the board, not the curtain: black frames cover almost none of the output.
    const { stderr } = await runFfmpeg(FFMPEG, buildBlackdetectArgs(output));
    const black = parseBlackIntervals(stderr).reduce((n, b) => n + (b.endSec - b.startSec), 0);
    expect(black).toBeLessThan(durationSec * 0.05);

    // The download link the status handed out works without a header.
    expect(status.downloadUrl).toMatch(/\/export\.mp4\?token=/);
    const dl = await fetch(status.downloadUrl ?? '');
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('video/mp4');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="pen-.*\.mp4"$/);
    expect(Number(dl.headers.get('content-length'))).toBe(statSync(output).size);
    await dl.arrayBuffer();

    // Idempotent: a second request is ready at once without another render.
    const before = h.lastRender;
    const again = await fetch(`${h.apiUrl}/api/sessions/${sessionId}/export`, {
      method: 'POST',
      headers: auth,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('ready');
    expect(h.lastRender).toBe(before);

    console.warn(
      `[export.integration] says=${render.sayStartsMs.length} spoken=${spokenSec.toFixed(2)}s ` +
        `duration=${durationSec.toFixed(2)}s drift=${render.syncDriftMs}ms bytes=${statSync(output).size} ` +
        `starts=${render.sayStartsMs.map((t) => Math.round(t)).join(',')}`,
    );
  }, 420_000);

  it('the ordinary replay page is unchanged: it waits for the click, then plays through the audio clock', async () => {
    expect(exportedSessionId).not.toBe('');
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${h.webUrl}/replay/${exportedSessionId}`, { waitUntil: 'domcontentloaded' });
      // No export bridge, no curtain, and nothing plays until the learner asks.
      expect(
        await page.evaluate(() => typeof (window as { __penExport?: unknown }).__penExport),
      ).toBe('undefined');
      expect(await page.locator('[data-testid="export-curtain"]').count()).toBe(0);
      const play = page.getByRole('button', { name: 'Play the session' });
      await play.waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1500);
      expect(await page.getByText("Let's start with a sentence", { exact: false }).count()).toBe(0);
      await play.click();
      // The first sentence's caption arrives through the PcmPlayer → conductor path.
      await page
        .getByText("Let's start with a sentence", { exact: false })
        .waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('button', { name: 'Pause' }).waitFor({ state: 'visible' });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 90_000);
});
