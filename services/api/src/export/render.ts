import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserType, chromium } from 'playwright';
import type { FileLedger } from '../ledger.js';
import {
  buildBlackdetectArgs,
  buildMuxArgs,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  parseBlackIntervals,
  runFfmpeg,
} from './ffmpeg.js';
import type { Renderer, RenderResult } from './jobs.js';
import { alignToTape, planExport } from './plan.js';

export interface PlaywrightRendererOptions {
  /** Origin that serves the web app (`/replay/:id?export=1`). */
  baseUrl: string;
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

/** Longest a single render may take, regardless of session length. */
const MAX_RENDER_MS = 45 * 60_000;
/** Frames written after the curtain drops so the trailing black interval is on tape. */
const CURTAIN_SETTLE_MS = 700;
/** The page's leading curtain must be at least this long to be the sync marker (screencast is 25 fps). */
const MIN_CURTAIN_SEC = 0.08;

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
 * started, and the trailing edge measures end-to-end drift between the page's
 * clock and the recording (`syncDriftMs`, reported and asserted in tests).
 */
export class PlaywrightRenderer implements Renderer {
  private readonly browserType: BrowserType;

  constructor(private readonly o: PlaywrightRendererOptions) {
    this.browserType = o.browserType ?? chromium;
  }

  /** Are ffmpeg and a Chromium reachable? Checked once at boot; the API refuses exports otherwise. */
  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await runFfmpeg(this.o.ffmpegPath, ['-version'], { timeoutMs: 10_000 });
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
    return { ok: true };
  }

  async render(input: {
    sessionId: string;
    sessionDir: string;
    outputPath: string;
    onProgress: (fraction: number) => void;
    signal: AbortSignal;
  }): Promise<RenderResult> {
    const { sessionId, sessionDir, outputPath, onProgress, signal } = input;
    const entries = this.o.ledger.read(sessionId);
    if (entries.length === 0) throw new Error('no ledger for this session');
    const plan = planExport(entries, join(sessionDir, 'audio'));
    const scratch = mkdtempSync(join(this.o.tmpDir ?? tmpdir(), 'pen-export-'));
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
      const curtain = await this.findCurtain(capture.videoPath, capture.doneMs);
      onProgress(0.88);
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
      const tmpOut = join(scratch, 'export.mp4');
      const durationSec = capture.doneMs / 1000;
      await runFfmpeg(
        this.o.ffmpegPath,
        buildMuxArgs({
          videoPath: capture.videoPath,
          videoStartSec: curtain.videoStartSec,
          durationSec,
          says,
          outputPath: tmpOut,
        }),
        { timeoutMs: MAX_RENDER_MS, signal },
      );
      renameSync(tmpOut, outputPath);
      this.o.onEvent?.('export.rendered', {
        sessionId,
        says: says.length,
        estimatedSays: plan.says.filter((s) => s.estimated).length,
        durationMs: Math.round(capture.doneMs),
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
    const launch = this.o.chromiumPath
      ? { executablePath: this.o.chromiumPath }
      : { channel: 'chromium' as const };
    const browser = await this.browserType.launch({
      ...launch,
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        ...(this.o.chromiumArgs ?? []),
      ],
    });
    onBrowser(browser);
    onProgress(0.03);
    const context = await browser.newContext({
      viewport: { width: EXPORT_WIDTH, height: EXPORT_HEIGHT },
      deviceScaleFactor: 1,
      recordVideo: { dir: scratch, size: { width: EXPORT_WIDTH, height: EXPORT_HEIGHT } },
      colorScheme: 'light',
    });
    const page = await context.newPage();
    const sayStarts: number[] = [];
    let settle: (v: { doneMs: number }) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const finished = new Promise<{ doneMs: number }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const hooks: PageHooks = {
      onSayStart: (_sayId, _take, videoTimeMs, index) => {
        sayStarts[index] = videoTimeMs;
        onProgress(0.05 + 0.75 * Math.min(1, (index + 1) / Math.max(1, total)));
      },
      onDone: (doneMs) => settle({ doneMs }),
      onError: (message) => fail(new Error(`replay page: ${message}`)),
    };
    await page.exposeFunction('__penExportOnSayStart', hooks.onSayStart);
    await page.exposeFunction('__penExportOnDone', hooks.onDone);
    await page.exposeFunction('__penExportOnError', hooks.onError);
    // A string, not a function: tsx/esbuild `keepNames` would inject a `__name` helper into a
    // stringified function that the page does not have.
    await page.addInitScript({ content: BRIDGE_SCRIPT });
    page.on('pageerror', (error) => fail(new Error(`replay page threw: ${error.message}`)));
    page.on('crash', () => fail(new Error('replay page crashed')));
    const onAbort = () => fail(new Error('render aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    const budgetMs = Math.min(MAX_RENDER_MS, 45_000 + spokenMs * 1.5);
    const timer = setTimeout(
      () => fail(new Error(`replay did not finish within ${Math.round(budgetMs / 1000)} s`)),
      budgetMs,
    );
    try {
      const url = `${this.o.baseUrl.replace(/\/$/, '')}/replay/${encodeURIComponent(sessionId)}?export=1`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      onProgress(0.05);
      const { doneMs } = await finished;
      // Keep recording briefly so the dropped curtain is on tape for the trailing sync edge.
      await page.waitForTimeout(CURTAIN_SETTLE_MS);
      const video = page.video();
      if (!video) throw new Error('no video was recorded');
      await page.close();
      await context.close();
      const videoPath = await video.path();
      if (sayStarts.length !== total || sayStarts.some((t) => t === undefined))
        throw new Error(
          `page reported ${sayStarts.filter((t) => t !== undefined).length}/${total} say starts`,
        );
      for (let i = 1; i < sayStarts.length; i++) {
        const a = sayStarts[i - 1] ?? 0;
        const b = sayStarts[i] ?? 0;
        if (b < a) throw new Error(`say starts not monotonic at ${i}: ${a} > ${b}`);
      }
      return { videoPath, doneMs, sayStarts };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Locate the sync curtain on the recording. */
  private async findCurtain(
    videoPath: string,
    doneMs: number,
  ): Promise<{ videoStartSec: number; driftMs: number | null }> {
    const { stderr } = await runFfmpeg(this.o.ffmpegPath, buildBlackdetectArgs(videoPath), {
      timeoutMs: 10 * 60_000,
    });
    const intervals = parseBlackIntervals(stderr).filter(
      (b) => b.endSec - b.startSec >= MIN_CURTAIN_SEC,
    );
    const lead = intervals[0];
    if (!lead) throw new Error('sync curtain not found on the recording');
    const videoStartSec = lead.endSec;
    const tail = intervals
      .slice(1)
      .find((b) => b.startSec >= videoStartSec + (doneMs / 1000) * 0.5);
    const driftMs = tail ? Math.round((tail.startSec - videoStartSec) * 1000 - doneMs) : null;
    return { videoStartSec, driftMs };
  }
}
