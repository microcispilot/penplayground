import { spawn } from 'node:child_process';

/**
 * ffmpeg command construction for the MP4 export, kept pure so the filter
 * graph is unit-testable byte for byte. Two passes:
 *
 * 1. `blackdetect` over the Playwright WebM finds the sync curtain: the page
 *    is solid black until the exact moment it marks `videoStart`, and turns
 *    black again when the replay is done. The first black interval's end is
 *    t=0 of the export; the second one's start measures drift.
 * 2. The mux: video trimmed at the curtain and transcoded to H.264 30 fps;
 *    each say's raw PCM delayed to the video offset the page reported for it,
 *    mixed without normalisation (says never overlap) into 44.1 kHz stereo AAC.
 */

export const EXPORT_WIDTH = 1280;
export const EXPORT_HEIGHT = 720;
export const EXPORT_FPS = 30;
export const EXPORT_AUDIO_RATE = 44100;
/** `amix normalize=` and `adelay all=` need this ffmpeg. */
export const MIN_FFMPEG_VERSION = [4, 4] as const;

export interface AudioPlacement {
  sayId: string;
  take: number;
  /** Where in the output this say starts, ms. */
  offsetMs: number;
  pcmPath: string;
  /** Audio the ledger accounts for; anything beyond it in the file is trimmed off. */
  durationMs: number;
  /** Sample rate of the raw file (s16le mono). Defaults to 44.1 kHz. */
  sampleRate?: 24000 | 44100 | 48000;
}

export interface MuxInput {
  videoPath: string;
  /** Video time (seconds) at which the export begins: the end of the leading black curtain. */
  videoStartSec: number;
  /** Output length, seconds. */
  durationSec: number;
  says: AudioPlacement[];
  outputPath: string;
}

/** Raw PCM inputs need their format declared before `-i`. */
function pcmInputArgs(say: AudioPlacement): string[] {
  return [
    '-f',
    's16le',
    '-ar',
    String(say.sampleRate ?? EXPORT_AUDIO_RATE),
    '-ac',
    '1',
    '-i',
    say.pcmPath,
  ];
}

/** The audio half of the filter graph: `atrim` + `adelay` per say, `amix` with `normalize=0`, stereo upmix, pad to the video. */
export function buildAudioFilter(says: AudioPlacement[]): { filter: string; label: string } {
  if (says.length === 0) {
    return {
      filter: `anullsrc=r=${EXPORT_AUDIO_RATE}:cl=stereo[a]`,
      label: '[a]',
    };
  }
  const chains = says.map((say, i) => {
    const delay = Math.max(0, Math.round(say.offsetMs));
    const end = (Math.max(1, say.durationMs) / 1000).toFixed(3);
    // Inputs are 1-based: input 0 is the video.
    return `[${i + 1}:a]atrim=end=${end},aresample=${EXPORT_AUDIO_RATE},adelay=delays=${delay}:all=1[d${i}]`;
  });
  const labels = says.map((_, i) => `[d${i}]`).join('');
  const mix = `${labels}amix=inputs=${says.length}:normalize=0:dropout_transition=0,aformat=sample_fmts=fltp:sample_rates=${EXPORT_AUDIO_RATE}:channel_layouts=stereo,apad[a]`;
  return { filter: [...chains, mix].join(';'), label: '[a]' };
}

/** The video half: trim at the curtain, re-time to t=0, constant 30 fps, exact size, 4:2:0 for every player. */
export function buildVideoFilter(videoStartSec: number): string {
  const start = Math.max(0, videoStartSec).toFixed(3);
  return `[0:v]trim=start=${start},setpts=PTS-STARTPTS,fps=${EXPORT_FPS},scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:flags=lanczos,format=yuv420p[v]`;
}

/** Full argv (without the binary) for the mux pass. Progress is reported on stdout (`-progress pipe:1`). */
export function buildMuxArgs(input: MuxInput): string[] {
  const audio = buildAudioFilter(input.says);
  const graph = `${buildVideoFilter(input.videoStartSec)};${audio.filter}`;
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-y',
    '-i',
    input.videoPath,
    ...input.says.flatMap(pcmInputArgs),
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    '-map',
    audio.label,
    '-t',
    Math.max(0.1, input.durationSec).toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(EXPORT_FPS),
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    String(EXPORT_AUDIO_RATE),
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    // The container is declared, not inferred: the file is written under a temp name first.
    '-f',
    'mp4',
    input.outputPath,
  ];
}

/** argv for the curtain-detection pass; the intervals are parsed from stderr with `parseBlackIntervals`. */
export function buildBlackdetectArgs(videoPath: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'info',
    '-i',
    videoPath,
    '-an',
    '-vf',
    'blackdetect=d=0.08:pix_th=0.10:pic_th=0.98',
    '-f',
    'null',
    '-',
  ];
}

export interface BlackInterval {
  startSec: number;
  endSec: number;
}

/** `[blackdetect @ …] black_start:1.24 black_end:2.08 black_duration:0.84` lines → intervals, in order. */
export function parseBlackIntervals(stderr: string): BlackInterval[] {
  const out: BlackInterval[] = [];
  const re = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g;
  for (const m of stderr.matchAll(re)) {
    const startSec = Number(m[1]);
    const endSec = Number(m[2]);
    if (Number.isFinite(startSec) && Number.isFinite(endSec)) out.push({ startSec, endSec });
  }
  return out;
}

/**
 * Pick the curtain edges that frame the export. The recording may start with
 * padding black (before the first screencast frame) and the app shell may
 * paint before the route mounts, so "first black interval" is not enough: of
 * every (lead, tail) pair, take the one whose gap best matches the length the
 * page reported. With no plausible tail, the earliest interval is the lead.
 */
export function chooseCurtain(
  intervals: BlackInterval[],
  doneMs: number,
  minSec = 0.08,
): { lead: BlackInterval; tail: BlackInterval | null } | null {
  const usable = intervals.filter((b) => b.endSec - b.startSec >= minSec);
  const first = usable[0];
  if (!first) return null;
  let best: { lead: BlackInterval; tail: BlackInterval; error: number } | null = null;
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const lead = usable[i];
      const tail = usable[j];
      if (!lead || !tail) continue;
      const gapMs = (tail.startSec - lead.endSec) * 1000;
      const error = Math.abs(gapMs - doneMs);
      // A tail closer than half the reported length cannot be the closing curtain.
      if (gapMs < doneMs * 0.5) continue;
      if (!best || error < best.error) best = { lead, tail, error };
    }
  }
  // Only accept a pair that agrees with the page to within 10 % (or 2 s, whichever is larger).
  if (best && best.error <= Math.max(2000, doneMs * 0.1))
    return { lead: best.lead, tail: best.tail };
  return { lead: first, tail: null };
}

export interface FfmpegResult {
  stdout: string;
  stderr: string;
}

export interface FfmpegRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** `-progress pipe:1` output: called with the output position in ms as encoding advances. */
  onProgress?: (outTimeMs: number) => void;
}

/**
 * Run ffmpeg/ffprobe. Rejects with an exit summary plus the tail of stderr so
 * failures are diagnosable from Sentry (the raw message never reaches users;
 * see jobs.ts). `-progress` key/value lines on stdout are parsed as they stream.
 */
export function runFfmpeg(
  bin: string,
  args: string[],
  opts: FfmpegRunOptions = {},
): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`timed out after ${opts.timeoutMs ?? 0} ms`)),
      opts.timeoutMs ?? 10 * 60_000,
    );
    const onAbort = () => finish(new Error('aborted'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (error: Error | null, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (error || code !== 0) {
        if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
        const tail = stderr.trim().split('\n').slice(-8).join('\n');
        const why = error ? error.message : `exit ${code}`;
        reject(new Error(`${bin} failed (${why})${tail ? `: ${tail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    };
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      if (!opts.onProgress) return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) opts.onProgress(Number(m[1]) / 1000);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      // Keep only the tail: ffmpeg can be chatty for hours.
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(null, code));
    if (opts.signal?.aborted) onAbort();
  });
}

/** `ffmpeg version 8.1.1 …` / `ffmpeg version n6.1.1-…` / `ffmpeg version 4.4.2-0ubuntu…` → [major, minor]. */
export function parseFfmpegVersion(versionOutput: string): [number, number] | null {
  const m = /ffmpeg version\s+n?(\d+)\.(\d+)/i.exec(versionOutput);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function ffmpegVersionOk(version: [number, number] | null): boolean {
  if (!version) return false;
  const [maj, min] = version;
  return (
    maj > MIN_FFMPEG_VERSION[0] || (maj === MIN_FFMPEG_VERSION[0] && min >= MIN_FFMPEG_VERSION[1])
  );
}

/** `ffprobe` lives next to `ffmpeg` (same package on every platform we ship). */
export function ffprobePathFor(ffmpegPath: string): string {
  return ffmpegPath.replace(
    /ffmpeg(\.exe)?$/i,
    (_m, ext: string | undefined) => `ffprobe${ext ?? ''}`,
  );
}
