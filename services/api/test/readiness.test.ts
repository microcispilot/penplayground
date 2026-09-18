import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from '@pen/db';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  CACHE_MS,
  checkDatabase,
  checkDataDir,
  checkProviders,
  ReadinessProbe,
} from '../src/readiness.js';

/**
 * `/api/ready` is what the container healthcheck, the edge and the uptime
 * monitor believe, so each failure mode it claims to catch is exercised here:
 * a database that is gone or hanging, a data directory that cannot be written,
 * and provider keys that were never filled in.
 */
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pen-ready-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already writable */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'readiness-secret-readiness-secret-x',
    PEN_DATA_DIR: tempDir(),
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    ...extra,
  });
}

/** A connection whose `ping` does what the test wants. */
function fakeDb(ping: () => Promise<unknown>): Connection {
  return {
    db: {} as Connection['db'],
    kind: 'pglite',
    ping: async () => void (await ping()),
    close: async () => undefined,
  };
}

describe('database check', () => {
  it('passes on a round-trip and fails with the reason when the database is gone', async () => {
    expect(await checkDatabase(fakeDb(async () => ({ rows: [{ '?column?': 1 }] })))).toEqual({
      ok: true,
    });
    const down = await checkDatabase(
      fakeDb(() => Promise.reject(new Error('connection refused 127.0.0.1:5432'))),
    );
    expect(down.ok).toBe(false);
    expect(down.detail).toContain('connection refused');
  });

  it('never carries a connection string out of the process', async () => {
    const leaky = await checkDatabase(
      fakeDb(() =>
        Promise.reject(
          new Error('connect ECONNREFUSED postgres://pen:hunter2@postgres:5432/pen failed'),
        ),
      ),
    );
    expect(leaky.ok).toBe(false);
    expect(leaky.detail).not.toContain('hunter2');
    expect(leaky.detail).toContain('<redacted>@');
    // Still useful to a human: the failure itself survives the redaction.
    expect(leaky.detail).toContain('ECONNREFUSED');
  });

  it('fails instead of hanging when the database never answers', async () => {
    const started = Date.now();
    const result = await checkDatabase(fakeDb(() => new Promise(() => undefined)));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/timed out/);
    // The probe must answer well inside a healthcheck's own timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});

describe('data directory check', () => {
  it('passes on a writable directory, creating it when it does not exist yet', () => {
    expect(checkDataDir(join(tempDir(), 'nested', 'sessions'))).toEqual({ ok: true });
  });

  it('fails when the directory cannot be written', () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    const result = checkDataDir(join(dir, 'data'));
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
  });
});

describe('provider check', () => {
  it('passes for the development providers and names every missing production key', () => {
    expect(checkProviders(config())).toEqual({ ok: true });

    const missing = checkProviders(
      config({ PEN_LLM_PROVIDER: 'openai', PEN_TTS_PROVIDER: 'fish-cloud' }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('OPENAI_API_KEY_FREE');
    expect(missing.detail).toContain('OPENAI_API_KEY_STANDARD');
    expect(missing.detail).toContain('OPENAI_API_KEY_PROFESSIONAL');
    expect(missing.detail).toContain('FISH_AUDIO_API_KEY');

    expect(
      checkProviders(
        config({
          PEN_LLM_PROVIDER: 'openai',
          OPENAI_API_KEY_FREE: 'k',
          OPENAI_API_KEY_STANDARD: 'k',
          OPENAI_API_KEY_PROFESSIONAL: 'k',
          PEN_TTS_PROVIDER: 'fish-cloud',
          FISH_AUDIO_API_KEY: 'k',
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('requires the key of whichever speech provider is configured', () => {
    expect(checkProviders(config({ PEN_STT_PROVIDER: 'deepgram' })).detail).toContain(
      'DEEPGRAM_API_KEY',
    );
    expect(checkProviders(config({ PEN_STT_PROVIDER: 'assemblyai' })).detail).toContain(
      'ASSEMBLYAI_API_KEY',
    );
    expect(checkProviders(config({ PEN_STT_PROVIDER: 'ws-relay' })).detail).toContain(
      'PEN_STT_RELAY_URL',
    );
    expect(checkProviders(config({ PEN_STT_PROVIDER: 'browser' }))).toEqual({ ok: true });
  });
});

describe('readiness probe', () => {
  it('reports every check and caches only a good answer', async () => {
    let calls = 0;
    let fail = false;
    const db = fakeDb(async () => {
      calls += 1;
      if (fail) throw new Error('database is down');
      return { rows: [] };
    });
    let clock = 1_000;
    const probe = new ReadinessProbe({ db, cfg: config() }, () => clock);

    const first = await probe.check();
    expect(first.ok).toBe(true);
    expect(first.checks).toEqual({
      db: { ok: true },
      dataDir: { ok: true },
      providers: { ok: true },
    });
    expect(typeof first.ms).toBe('number');

    // Inside the cache window the database is not touched again…
    await probe.check();
    expect(calls).toBe(1);
    // …and after it, it is.
    clock += CACHE_MS + 1;
    await probe.check();
    expect(calls).toBe(2);

    // A failure is never cached: the next probe must see the recovery at once.
    fail = true;
    clock += CACHE_MS + 1;
    const bad = await probe.check();
    expect(bad.ok).toBe(false);
    expect(bad.checks.db.ok).toBe(false);
    expect(calls).toBe(3);
    await probe.check();
    expect(calls).toBe(4);
    fail = false;
    expect((await probe.check()).ok).toBe(true);
  });
});
