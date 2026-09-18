import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMessage, ServerMessage } from '@pen/contracts';
import WebSocket from 'ws';
import { percentile } from '../src/telemetry.js';

/**
 * Concurrency check for one API process (docs/RUNBOOK.md → "Scaling").
 *
 *   pnpm --filter @pen/api load --sessions 20
 *   pnpm --filter @pen/api load --sessions 50 --ramp 40
 *   PEN_API_URL=http://127.0.0.1:4022 pnpm --filter @pen/api load --sessions 20   # existing API
 *
 * It opens N concurrent WebSocket sessions against a local API running the
 * scripted model and the silent synthesizer (which still streams PCM in real
 * time, so the fan-out is real work), asks one question in each, ends them,
 * and prints p50/p95 for:
 *
 *   time-to-first-cue      session create → the first cue of the lesson
 *   question → answer      the final transcript → the first cue of the answer
 *   health ping            a trivial GET, sampled throughout: the client-side
 *                          view of event-loop stalls (a blocked loop shows up
 *                          here before it shows up anywhere else)
 *
 * plus the API process's RSS and CPU, sampled with `ps` so the numbers belong
 * to the server, not to this driver. Without `PEN_API_URL` it starts (and
 * stops) its own API, so a run needs nothing but the repo.
 */
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v !== undefined && !v.startsWith('--') ? v : fallback;
};
const sessions = Math.max(1, Number(value('--sessions', '20')));
/** Milliseconds between two starts: real learners never arrive in one tick. */
const rampMs = Math.max(0, Number(value('--ramp', '50')));
/** Repeat the same concurrent load N times against one process: a soak. */
const waves = Math.max(1, Number(value('--waves', '1')));
const askQuestion = !flag('--no-question');
const saysBeforeQuestion = Math.max(1, Number(value('--says', '2')));
const externalApi = process.env.PEN_API_URL ?? (flag('--api') ? value('--api', '') : '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url}/api/ready`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error(`API at ${url} was not ready within ${timeoutMs} ms`);
}

/** RSS in bytes and cumulative CPU seconds of a pid, via ps (no native deps). */
function sampleProcess(pid: number): { rssBytes: number; cpuSeconds: number } | null {
  try {
    const out = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    const [rssKb, time] = out.split(/\s+/);
    if (!rssKb || !time) return null;
    // [DD-]HH:MM:SS[.ss] or MM:SS.ss
    const [days, rest] = time.includes('-') ? time.split('-') : ['0', time];
    const parts = (rest ?? '').split(':').map(Number);
    const seconds = parts.reduce((acc, part) => acc * 60 + part, 0) + Number(days) * 86_400;
    return { rssBytes: Number(rssKb) * 1024, cpuSeconds: seconds };
  } catch {
    return null;
  }
}

interface SessionResult {
  ok: boolean;
  /** Session created → the first lesson cue the client can act on. */
  firstCueMs: number | null;
  /** Session created → the first audible PCM frame (the product's own metric). */
  firstAudioMs: number | null;
  /** The learner's final words → the first audio of the reply. */
  answerMs: number | null;
  error?: string;
}

/**
 * One learner: authenticate, start a session, join the room, wait for cues,
 * ask a question, end. Every client gets its own `X-Real-IP` because that is
 * what the edge sends and what the rate limiter buckets by.
 */
async function runSession(api: string, index: number): Promise<SessionResult> {
  const ip = `203.0.113.${(index % 250) + 1}`;
  const headers = { 'content-type': 'application/json', 'x-real-ip': ip };
  const result: SessionResult = {
    ok: false,
    firstCueMs: null,
    firstAudioMs: null,
    answerMs: null,
  };
  try {
    const auth = (await fetch(`${api}/api/auth/anonymous`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: `Load ${index}` }),
    }).then((r) => {
      if (!r.ok) throw new Error(`auth ${r.status}`);
      return r.json();
    })) as { token: string; participant: { id: string } };
    const authed = { ...headers, authorization: `Bearer ${auth.token}` };

    const startedAt = Date.now();
    const created = await fetch(`${api}/api/sessions`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
    });
    if (created.status !== 201) throw new Error(`create ${created.status}`);
    const { session } = (await created.json()) as { session: { id: string } };

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${api.replace('http', 'ws')}/ws/room`);
      const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('session did not progress within 180 s'));
      }, 180_000);
      let says = 0;
      let asked = false;
      let askedAt = 0;
      const finish = () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      };
      ws.on('open', () => {
        send({ kind: 'auth', token: auth.token });
        send({ kind: 'join', sessionId: session.id });
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          // Audio is the metric that matters: it is what the learner hears, and
          // it is the one the Insights tab and PostHog already report.
          if (result.firstAudioMs === null) result.firstAudioMs = Date.now() - startedAt;
          // The lesson's audio stops on the interrupt, so the next frame is the reply.
          if (asked && result.answerMs === null) result.answerMs = Date.now() - askedAt;
          return;
        }
        const msg = JSON.parse(String(data)) as ServerMessage;
        if (msg.kind === 'error') {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`room ${msg.code}`));
          return;
        }
        // A room whose plan already existed (a lesson-memo hit) has its cues
        // banked before the join, so they arrive in `ready.backlog` rather
        // than as `cue` messages. Counting only `cue` here would time the
        // *second* sentence and read as a 25× regression on the fast path.
        if (msg.kind === 'ready' && msg.backlog.length > 0 && result.firstCueMs === null)
          result.firstCueMs = Date.now() - startedAt;
        if (msg.kind === 'cue' && result.firstCueMs === null)
          result.firstCueMs = Date.now() - startedAt;
        if (msg.kind === 'say_complete') {
          says += 1;
          if (msg.sayId.startsWith('L0.'))
            send({ kind: 'progress', seq: says - 1, clockMs: 1_000 });
          if (says >= saysBeforeQuestion && !asked) {
            if (!askQuestion) return finish();
            asked = true;
            askedAt = Date.now();
            send({ kind: 'interrupt', atSeq: says - 1, sayId: msg.sayId, offsetMs: 400 });
            send({
              kind: 'transcript',
              utteranceId: 'u1',
              text: 'Why do we divide by the square root of d?',
              final: true,
            });
          }
        }
        if (msg.kind === 'turn_done') finish();
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    const ended = await fetch(`${api}/api/sessions/${session.id}/end`, {
      method: 'POST',
      headers: authed,
    });
    if (!ended.ok) throw new Error(`end ${ended.status}`);
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function ms(n: number | null): string {
  return n === null ? '—' : `${Math.round(n)} ms`;
}

function row(label: string, values: number[]): string {
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const max = values.length > 0 ? Math.max(...values) : null;
  return `${label.padEnd(24)} n=${String(values.length).padEnd(4)} p50 ${ms(p50).padEnd(10)} p95 ${ms(p95).padEnd(10)} max ${ms(max)}`;
}

async function main(): Promise<void> {
  let child: ChildProcess | null = null;
  let api = externalApi;
  if (!api) {
    const port = await freePort();
    api = `http://127.0.0.1:${port}`;
    child = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PEN_PORT: String(port),
        PEN_JWT_SECRET: 'load-test-secret-load-test-secret-1234',
        PEN_LLM_PROVIDER: 'fake',
        PEN_TTS_PROVIDER: 'silent',
        PEN_STT_PROVIDER: 'browser',
        // PGlite is wasm *in this process*: it serialises queries and blocks the
        // event loop, which production (real Postgres over a socket) does not.
        // Point this at a Postgres to measure what production actually does.
        DATABASE_URL: process.env.PEN_LOAD_DATABASE_URL ?? 'pglite://memory',
        PEN_DATA_DIR: join(root, '.pen-data-load'),
        PEN_LOG_LEVEL: 'warn',
        SENTRY_DSN: '',
        POSTHOG_PROJECT_TOKEN: '',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    console.log(`api: started pid ${child.pid} on ${api}`);
  } else {
    console.log(`api: using ${api}`);
  }
  await waitForReady(api, 90_000);

  // Sampled throughout the run: a trivial request's latency is the clearest
  // client-visible symptom of an event loop that stopped turning.
  const healthMs: number[] = [];
  let sampling = true;
  const healthSampler = (async () => {
    while (sampling) {
      const at = Date.now();
      try {
        const res = await fetch(`${api}/api/health`);
        await res.text();
        healthMs.push(Date.now() - at);
      } catch {
        healthMs.push(Number.POSITIVE_INFINITY);
      }
      await sleep(500);
    }
  })();

  const pid = child?.pid ?? null;
  const first = pid ? sampleProcess(pid) : null;
  // Idle RSS right after boot: PGlite's wasm heap and the language-id model are
  // most of it, so only the delta is per-session cost.
  const rssBaseline = first?.rssBytes ?? 0;
  let rssMax = rssBaseline;
  let cpuLast = first?.cpuSeconds ?? 0;
  const resourceSampler = setInterval(() => {
    if (!pid) return;
    const s = sampleProcess(pid);
    if (s) {
      rssMax = Math.max(rssMax, s.rssBytes);
      cpuLast = s.cpuSeconds;
    }
  }, 1_000);
  resourceSampler.unref();

  console.log(
    `load: ${sessions} concurrent sessions × ${waves} wave(s), ${rampMs} ms apart, question=${askQuestion}`,
  );
  const wallStart = Date.now();
  const results: SessionResult[] = [];
  const settleMs = Number(value('--settle', '10000'));
  for (let wave = 0; wave < waves; wave += 1) {
    const running = [];
    for (let i = 0; i < sessions; i += 1) {
      running.push(runSession(api, wave * sessions + i));
      if (rampMs > 0) await sleep(rampMs);
    }
    results.push(...(await Promise.all(running)));
    if (waves > 1 && pid) {
      // Settled RSS per wave is the leak test: flat across waves means the peak
      // is concurrency (fine); a staircase means something is retained per
      // session (not fine).
      await sleep(settleMs);
      const s = sampleProcess(pid);
      console.log(
        `  wave ${wave + 1}/${waves}: ${(results.length / sessions).toFixed(0)} × ${sessions} sessions done, rss settled ${((s?.rssBytes ?? 0) / 1024 / 1024).toFixed(0)} MB`,
      );
    }
  }
  const wallMs = Date.now() - wallStart;
  sampling = false;
  await healthSampler;
  clearInterval(resourceSampler);

  // Peak RSS is a high-water mark; what matters for a long-lived process is
  // whether it comes back. Sample again after the rooms have been swept.
  let rssSettled = 0;
  if (pid) {
    await sleep(settleMs);
    rssSettled = sampleProcess(pid)?.rssBytes ?? 0;
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const firstCue = ok.flatMap((r) => (r.firstCueMs === null ? [] : [r.firstCueMs]));
  const firstAudio = ok.flatMap((r) => (r.firstAudioMs === null ? [] : [r.firstAudioMs]));
  const answers = ok.flatMap((r) => (r.answerMs === null ? [] : [r.answerMs]));
  const cpuSeconds = Math.max(0, cpuLast - (first?.cpuSeconds ?? 0));

  console.log('');
  console.log(
    `sessions                 ${ok.length}/${sessions * waves} completed in ${(wallMs / 1000).toFixed(1)} s`,
  );
  console.log(row('time-to-first-cue', firstCue));
  console.log(row('time-to-first-audio', firstAudio));
  console.log(row('question → answer', answers));
  console.log(row('health ping', healthMs.filter(Number.isFinite)));
  if (pid) {
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
    console.log(
      `api rss                  ${mb(rssBaseline)} MB idle → ${mb(rssMax)} MB peak (+${mb(rssMax - rssBaseline)} MB, ${((rssMax - rssBaseline) / 1024 / 1024 / sessions).toFixed(1)} MB/session) → ${mb(rssSettled)} MB settled`,
    );
    console.log(
      `api cpu                  ${cpuSeconds.toFixed(1)} s over ${(wallMs / 1000).toFixed(1)} s wall (${((cpuSeconds / (wallMs / 1000)) * 100).toFixed(0)} % of one core)`,
    );
  }
  if (failed.length > 0) {
    const reasons = new Map<string, number>();
    for (const f of failed)
      reasons.set(f.error ?? 'unknown', (reasons.get(f.error ?? 'unknown') ?? 0) + 1);
    console.log('');
    console.log(`failures: ${failed.length}`);
    for (const [reason, count] of reasons) console.log(`  ${count} × ${reason}`);
  }

  child?.kill('SIGTERM');
  // A clean shutdown flushes the ledger; don't leave a zombie if it hangs.
  if (child) {
    await Promise.race([new Promise((r) => child?.once('exit', r)), sleep(5_000)]);
    child.kill('SIGKILL');
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
