import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserType, chromium } from 'playwright';
import type { FileLedger } from '../ledger.js';
import {
  buildBlackdetectArgs,
  buildMuxArgs,
  chooseCurtain,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  ffmpegVersionOk,
  MIN_FFMPEG_VERSION,
  parseBlackIntervals,
  parseFfmpegVersion,
  runFfmpeg,
} from './ffmpeg.js';
import { RenderError, type Renderer, type RenderResult } from './jobs.js';
import { alignToTape, planExport } from './plan.js';

export interface PlaywrightRendererOptions {
  /** Origin that serves the web app (`/replay/:id?export=1`). */
  baseUrl: string;
  /** Origins the page may reach besides `baseUrl` (the API when it is not proxied). */
  allowedOrigins?: string[] | undefined;
  ffmpegPath: string;
  /** System Chromium; when absent Playwright's own `chromium` channel is used. */
  chromiumPath?: string | undefined;
  /** Extra Chromium flags (e.g. `--disable-dev-shm-usage` in Docker). */
  chromiumArgs?: string[] | undefined;
  ledger: FileLedger;
  /** Scratch space for the WebM; defaults to the OS temp dir. */
  tmpDir?: string | undefined;
  /** Seam for tests. */
  browserType?: BrowserType | undefined;
  onEvent?: ((name: string, data: Record<string, number | boolean | string>) => void) | undefined;
}

/** The hooks the replay page calls in export mode (see packages/app Replay.tsx). */
export interface PageHooks {
  onSayStart(sayId: string, take: number, videoTimeMs: number, index: number, total: number): void;
  onDone(doneMs: number): void;
  onError(message: string): void;
}

/** Installs `window.__penExport` (see Replay.tsx) over the functions exposed by `record()`. */
const BRIDGE_SCRIPT = `window.__penExport = {
  onSayStart: (...a) => window.__penExportOnSayStart(...a),
  onDone: (...a) => window.__penExportOnDone(...a),
  onError: (...a) => window.__penExportOnError(...a),
};`;

/** Longest a single render may take, regardless of session length (45 min of speech + transcode). */
const MAX_RENDER_MS = 90 * 60_000;
/** Frames written after the curtain drops so the trailing black interval is on tape. */
const CURTAIN_SETTLE_MS = 700;
/** The page's curtain must be at least this long to be a sync marker (screencast is 25 fps). */
const MIN_CURTAIN_SEC = 0.08;
/** Beyond this the page clock and the recording disagree too much to trust either. */
const MAX_DRIFT_MS = 500;

/**
 * Renders a session deterministically: headless Chromium plays the replay page
 * in export mode while Playwright records the screen; the page reports the
 * video time at which every sentence began; ffmpeg then places each sentence's
 * PCM at that offset and muxes it with the H.264 transcode.
 *
 * Sync guarantee: the page is a solid black curtain until it marks `videoStart`
 * (a `requestAnimationFrame` that lifts the curtain and starts the export clock
 * in the same tick), and drops the curtain again when done. `blackdetect` finds
 * both edges on the recording, so t=0 of the output is the very frame the clock
 * started; the trailing edge measures end-to-end drift between the page's clock
 * and the recording (`syncDriftMs`), which is reported, applied as a linear
 * correction to the audio offsets, and asserted in the integration test.
 */
export class PlaywrightRenderer implements Renderer {
  private readonly browserType: BrowserType;

  constructor(private readonly o: PlaywrightRendererOptions) {
    this.browserType = o.browserType ?? chromium;
  }

  /** Are a recent-enough ffmpeg and a launchable Chromium here? Checked once at boot; the API refuses exports otherwise. */
  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const { stdout } = await runFfmpeg(this.o.ffmpegPath, ['-version'], { timeoutMs: 10_000 });
      const version = parseFfmpegVersion(stdout);
      if (!ffmpegVersionOk(version))
        return {
          ok: false,
          reason: `ffmpeg ${version ? version.join('.') : '(unknown version)'} is older than ${MIN_FFMPEG_VERSION.join('.')}`,
        };
    } catch (error) {
      return {
        ok: false,
        reason: `ffmpeg: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const exe = this.o.chromiumPath ?? this.browserType.executablePath();
    if (!exe || !existsSync(exe))
      return {
        ok: false,
        reason: `Chromium not found at ${exe || '(none)'}; run \`pnpm exec playwright install chromium\` or set PEN_CHROMIUM_PATH`,
      };
    // The path check passes with only the headless shell installed; a real launch is the truth.
    try {
      const browser = await this.launch();
      await browser.close();
    } catch (error) {
      return {
        ok: false,
        reason: `Chromium failed to launch: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      };
    }
    return { ok: true };
  }

  private launch(): Promise<Browser> {
    const launch = this.o.chromiumPath
      ? { executablePath: this.o.chromiumPath }
      : { channel: 'chromium' as const };
    return this.browserType.launch({
      ...launch,
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        ...(this.o.chromiumArgs ?? []),
      ],
    });
  }

  async render(input: {
    sessionId: string;
    sessionDir: string;
    outputPath: string;
    onProgress: (fraction: number) => void;
    signal: AbortSignal;
  }): Promise<RenderResult> {
    const { sessionId, sessionDir, outputPath, onProgress, signal } = input;
    signal.throwIfAborted();
    const entries = this.o.ledger.read(sessionId);
    if (entries.length === 0)
      throw new RenderError('This session has nothing to export.', 'no ledger for this session');
    const plan = planExport(entries, join(sessionDir, 'audio'));
    const scratch = mkdtempSync(join(this.o.tmpDir ?? tmpdir(), 'pen-export-'));
    // Written next to the final file so the last step is an atomic same-filesystem rename
    // (the scratch dir may be a tmpfs on another mount).
    const tmpOut = `${outputPath}.tmp`;
    let browser: Browser | null = null;
    try {
      const capture = await this.record(
        sessionId,
        plan.says.length,
        plan.spokenMs,
        scratch,
        onProgress,
        signal,
        (b) => {
          browser = b;
        },
      );
      onProgress(0.84);
      const curtain = await this.findCurtain(capture.videoPath, capture.doneMs, signal);
      onProgress(0.88);
      // The recording's clock vs the page's: correct the audio offsets by the measured stretch.
      const tapeStarts = alignToTape(capture.sayStarts, capture.doneMs, curtain.driftMs);
      const says = plan.says.flatMap((say, i) => {
        const offsetMs = tapeStarts[i];
        if (!say.pcmPath || offsetMs === undefined || !existsSync(say.pcmPath)) return [];
        return [
          {
            sayId: say.sayId,
            take: say.take,
            offsetMs,
            pcmPath: say.pcmPath,
            durationMs: say.durationMs,
            sampleRate: say.sampleRate,
          },
        ];
      });
      const durationSec = (curtain.measuredMs ?? capture.doneMs) / 1000;
      await runFfmpeg(
        this.o.ffmpegPath,
        buildMuxArgs({
          videoPath: capture.videoPath,
          videoStartSec: curtain.videoStartSec,
          durationSec,
          says,
          outputPath: tmpOut,
        }),
        {
          timeoutMs: MAX_RENDER_MS,
          signal,
          onProgress: (outMs) =>
            onProgress(0.88 + 0.11 * Math.min(1, outMs / Math.max(1, durationSec * 1000))),
        },
      );
      renameSync(tmpOut, outputPath);
      this.o.onEvent?.('export.rendered', {
        sessionId,
        says: says.length,
        estimatedSays: plan.says.filter((s) => s.estimated).length,
        durationMs: Math.round(durationSec * 1000),
        curtainSec: curtain.videoStartSec,
        syncDriftMs: curtain.driftMs ?? -1,
      });
      return {
        durationMs: capture.doneMs,
        syncDriftMs: curtain.driftMs,
        sayStartsMs: capture.sayStarts,
        tapeStartsMs: tapeStarts,
      };
    } finally {
      const b = browser as Browser | null;
      if (b) await b.close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
      rmSync(tmpOut, { force: true });
    }
  }

  /** Drive the page to completion; resolves with the WebM path and the page-reported timeline. */
  private async record(
    sessionId: string,
    total: number,
    spokenMs: number,
    scratch: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
    onBrowser: (b: Browser) => void,
  ): Promise<{ videoPath: string; doneMs: number; sayStarts: number[] }> {
    const browser = await this.launch();
    onBrowser(browser);
    signal.throwIfAborted();
    onProgress(0.03);
    const context = await browser.newContext({
      viewport: { width: EXPORT_WIDTH, height: EXPORT_HEIGHT },
      deviceScaleFactor: 1,
      recordVideo: { dir: scratch, size: { width: EXPORT_WIDTH, height: EXPORT_HEIGHT } },
      colorScheme: 'light',
    });
    // The render host must not fetch arbitrary URLs that lesson content may carry.
    const allowed = new Set(
      [this.o.baseUrl, ...(this.o.allowedOrigins ?? [])].map((u) => new URL(u).origin),
    );
    await context.route('**/*', (route) => {
      const url = route.request().url();
      const ok =
        url.startsWith('data:') || url.startsWith('blob:') || allowed.has(new URL(url).origin);
      return ok ? route.continue() : route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const sayStarts: number[] = [];
    let settle: (v: { doneMs: number }) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const finished = new Promise<{ doneMs: number }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // `fail` may fire before `finished` is awaited (during goto); never let that surface as unhandled.
    finished.catch(() => undefined);
    // Uncaught page errors are recorded, not fatal: the replay reports its own failures through
    // `onError`, and blocked third-party requests (analytics, fonts) must never sink a render.
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      if (pageErrors.length < 5) pageErrors.push(error.message.slice(0, 200));
    });
    const hooks: PageHooks = {
      onSayStart: (_sayId, _take, videoTimeMs, index) => {
        sayStarts[index] = videoTimeMs;
        onProgress(0.05 + 0.75 * Math.min(1, (index + 1) / Math.max(1, total)));
      },
      onDone: (doneMs) => settle({ doneMs }),
      onError: (message) =>
        fail(
          new RenderError(
            'The replay could not be played back.',
            `replay page: ${message}${pageErrors.length ? ` | page errors: ${pageErrors.join(' | ')}` : ''}`,
          ),
        ),
    };
    await page.exposeFunction('__penExportOnSayStart', hooks.onSayStart);
    await page.exposeFunction('__penExportOnDone', hooks.onDone);
    await page.exposeFunction('__penExportOnError', hooks.onError);
    // A string, not a function: tsx/esbuild `keepNames` would inject a `__name` helper into a
    // stringified function that the page does not have.
    await page.addInitScript({ content: BRIDGE_SCRIPT });

    page.on('crash', () => fail(new Error('replay page crashed')));
    const onAbort = () => fail(new Error('render aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const budgetMs = Math.min(MAX_RENDER_MS, 120_000 + spokenMs * 1.5);
    const timer = setTimeout(
      () =>
        fail(
          new RenderError(
            'The replay took too long to play back.',
            `replay did not finish within ${Math.round(budgetMs / 1000)} s${pageErrors.length ? ` | page errors: ${pageErrors.join(' | ')}` : ''}`,
          ),
        ),
      budgetMs,
    );
    try {
      const url = `${this.o.baseUrl.replace(/\/$/, '')}/replay/${encodeURIComponent(sessionId)}?export=1`;
      await Promise.race([
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
        finished,
      ]);
      onProgress(0.05);
      const { doneMs } = await finished;
      // Keep recording briefly so the dropped curtain is on tape for the trailing sync edge.
      await page.waitForTimeout(CURTAIN_SETTLE_MS);
      const video = page.video();
      if (!video) throw new Error('no video was recorded');
      await page.close();
      await context.close();
      const videoPath = await video.path();
      for (let i = 0; i < total; i++) {
        const t = sayStarts[i];
        if (t === undefined)
          throw new Error(`page never reported the start of say ${i + 1}/${total}`);
        const prev = sayStarts[i - 1];
        if (i > 0 && prev !== undefined && t < prev)
          throw new Error(`say starts not monotonic at ${i}: ${prev} > ${t}`);
      }
      return { videoPath, doneMs, sayStarts: sayStarts.slice(0, total) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Locate the sync curtain on the recording. */
  private async findCurtain(
    videoPath: string,
    doneMs: number,
    signal: AbortSignal,
  ): Promise<{ videoStartSec: number; measuredMs: number | null; driftMs: number | null }> {
    const { stderr } = await runFfmpeg(this.o.ffmpegPath, buildBlackdetectArgs(videoPath), {
      timeoutMs: MAX_RENDER_MS,
      signal,
    });
    const curtain = chooseCurtain(parseBlackIntervals(stderr), doneMs, MIN_CURTAIN_SEC);
    if (!curtain)
      throw new RenderError(
        'The recording could not be aligned.',
        'sync curtain not found on the recording',
      );
    const videoStartSec = curtain.lead.endSec;
    const measuredMs = curtain.tail ? (curtain.tail.startSec - videoStartSec) * 1000 : null;
    const driftMs = measuredMs === null ? null : Math.round(measuredMs - doneMs);
    if (driftMs !== null && Math.abs(driftMs) > MAX_DRIFT_MS)
      throw new RenderError(
        'The recording could not be aligned.',
        `video/page drift ${driftMs} ms exceeds ${MAX_DRIFT_MS} ms`,
      );
    return { videoStartSec, measuredMs, driftMs };
  }
}
