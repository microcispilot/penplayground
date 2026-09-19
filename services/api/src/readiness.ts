import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from '@pen/db';
import type { Config } from './config.js';

/**
 * Readiness (`GET /api/ready`): can this process serve a lesson *right now*?
 *
 * `/api/health` answers "the process is up and this is how it is configured";
 * it stays 200 even when the database is gone, because it is what the deploy
 * script and a human read. Readiness is the machine-facing question the
 * container healthcheck, the edge and the uptime monitor ask, so it fails
 * (503) the moment a dependency a session needs is unusable:
 *
 *   db         a `select 1` round-trip (the participant row, the session index)
 *   dataDir    the ledger's directory accepts a write (full or read-only disk)
 *   providers  the model and voice keys the configured providers require
 *
 * Every check is bounded by `TIMEOUT_MS` so a hung database can never hold the
 * healthcheck open, and a good answer is cached for `CACHE_MS` so a 5 s probe
 * interval across four consumers still costs one round-trip per interval.
 */
export interface ReadyCheck {
  ok: boolean;
  /** Why it failed — a code or a short reason, never a secret or a query. */
  detail?: string;
}

export interface Readiness {
  ok: boolean;
  checks: { db: ReadyCheck; dataDir: ReadyCheck; providers: ReadyCheck };
  /** How long the checks took, in milliseconds. */
  ms: number;
}

/** A check that hangs is a check that failed: the probe must always answer. */
export const TIMEOUT_MS = 2_000;
/** A passing result is reused for this long; a failing one is never cached. */
export const CACHE_MS = 1_000;

/**
 * `detail` is what an operator reads at 2 a.m., but this endpoint is reachable
 * from the internet through the edge, so a driver message must never carry a
 * connection string out with it: any `scheme://user:password@host` is redacted
 * before the message is trimmed.
 */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*@/gi, '<redacted>@').slice(0, 200);
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One round-trip to the database the session index and participants live in. */
export async function checkDatabase(db: Connection): Promise<ReadyCheck> {
  try {
    await withTimeout(db.ping(), TIMEOUT_MS, 'database');
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: reason(error) };
  }
}

/**
 * The ledger's directory must accept a write: a full disk or a volume that
 * came back read-only is invisible until a lesson tries to record itself.
 */
export function checkDataDir(dataDir: string): ReadyCheck {
  const probe = join(dataDir, '.ready-probe');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(probe, String(Date.now()));
    unlinkSync(probe);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: reason(error) };
  }
}

/**
 * The keys the configured providers need. Config already refuses the fake
 * model and the silent synthesizer in production, so this is about missing
 * credentials, not about which provider was chosen: a container that booted
 * before the operator filled `api.env` must never take traffic.
 */
export function checkProviders(cfg: Config): ReadyCheck {
  const missing: string[] = [];
  if (cfg.PEN_LLM_PROVIDER !== 'fake') {
    for (const plan of ['FREE', 'STANDARD', 'PROFESSIONAL'] as const)
      if (!cfg[`OPENAI_API_KEY_${plan}`]) missing.push(`OPENAI_API_KEY_${plan}`);
  }
  if (cfg.PEN_TTS_PROVIDER === 'fish-cloud' && !cfg.FISH_AUDIO_API_KEY)
    missing.push('FISH_AUDIO_API_KEY');
  if (cfg.PEN_STT_PROVIDER === 'deepgram' && !cfg.DEEPGRAM_API_KEY)
    missing.push('DEEPGRAM_API_KEY');
  if (cfg.PEN_STT_PROVIDER === 'assemblyai' && !cfg.ASSEMBLYAI_API_KEY)
    missing.push('ASSEMBLYAI_API_KEY');
  if (cfg.PEN_STT_PROVIDER === 'ws-relay' && !cfg.PEN_STT_RELAY_URL)
    missing.push('PEN_STT_RELAY_URL');
  // `PEN_INTENT_PROVIDER=jev` without a key is deliberately NOT a missing
  // provider: the room falls back to the session model, which is what it did
  // before the hosted classifier existed, so the stack can still serve a
  // lesson. It is a configuration to fix, not a reason to refuse traffic —
  // `intent.no_key` says so once in the log and `/api/health` reports the
  // classifier that is actually running.
  return missing.length === 0
    ? { ok: true }
    : { ok: false, detail: `missing: ${missing.join(', ')}` };
}

/**
 * The readiness probe, with a short positive cache. Hand it the connection and
 * the config; it owns nothing else, so tests drive it directly and the route is
 * one line.
 */
export class ReadinessProbe {
  private cached: { at: number; result: Readiness } | null = null;

  constructor(
    private readonly deps: { db: Connection; cfg: Config },
    private readonly now: () => number = () => Date.now(),
  ) {}

  async check(): Promise<Readiness> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < CACHE_MS) return cached.result;
    const started = this.now();
    const [db, dataDir, providers] = [
      await checkDatabase(this.deps.db),
      checkDataDir(this.deps.cfg.PEN_DATA_DIR),
      checkProviders(this.deps.cfg),
    ];
    const result: Readiness = {
      ok: db.ok && dataDir.ok && providers.ok,
      checks: { db, dataDir, providers },
      ms: Math.max(0, this.now() - started),
    };
    // Only a good answer is cached: a failing dependency must be re-checked on
    // the next probe so recovery is noticed at once.
    this.cached = result.ok ? { at: this.now(), result } : null;
    return result;
  }
}
