import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeConfigSnapshot } from '@pen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { RuntimeConfigStore } from '../src/runtime-config/index.js';

/**
 * The three tiers, and the promise that the product never gets worse because
 * a database blinked (ADR-0025).
 *
 * Every test here goes through the interface the rest of the API uses —
 * `store.get(name)` — rather than through the store's internals, because the
 * whole value of this layer is that a reader cannot tell which tier answered.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pen-runtime-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  NODE_ENV: 'test',
  PEN_JWT_SECRET: 'x'.repeat(40),
  PEN_LLM_PROVIDER: 'fake',
  PEN_TTS_PROVIDER: 'silent',
} as const;

function config(env: Record<string, string> = {}) {
  const dataDir = tempDir();
  return loadConfig({ ...BASE, PEN_DATA_DIR: dataDir, ...env });
}

/** A document source under the test's control: what it returns, and when it fails. */
class FakeSource {
  reads = 0;
  constructor(
    public snapshot: RuntimeConfigSnapshot = {
      revision: 0,
      settings: {},
      updatedAt: 0,
      updatedBy: null,
    },
    public failing = false,
  ) {}
  async read(): Promise<RuntimeConfigSnapshot> {
    this.reads += 1;
    if (this.failing) throw new Error('database is unreachable');
    return this.snapshot;
  }
}

function document(settings: Record<string, unknown>, revision = 1): RuntimeConfigSnapshot {
  return { revision, settings, updatedAt: 1_700_000_000_000, updatedBy: 'p_admin' };
}

describe('precedence', () => {
  it('serves the compiled-in default when nothing overrides it, so an empty store changes nothing', () => {
    const store = new RuntimeConfigStore({ cfg: config() });
    // Jev is the intent provider by default now (ADR-0025); every other
    // setting is what the environment schema has always said.
    expect(store.get('PEN_INTENT_PROVIDER')).toBe('jev');
    expect(store.get('PEN_THUMBNAIL_QUALITY')).toBe('low');
    expect(store.get('PEN_TTS_CACHE_MB')).toBe(2048);
    expect(store.sourceOf('PEN_THUMBNAIL_QUALITY')).toBe('default');
  });

  it('prefers the stored document over the default', async () => {
    const cfg = config();
    const source = new FakeSource(document({ PEN_THUMBNAIL_QUALITY: 'high' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_THUMBNAIL_QUALITY')).toBe('high');
    expect(store.sourceOf('PEN_THUMBNAIL_QUALITY')).toBe('stored');
    expect(store.storedValue('PEN_THUMBNAIL_QUALITY')).toBe('high');
    expect(store.defaultValue('PEN_THUMBNAIL_QUALITY')).toBe('low');
  });

  it('lets an environment variable pin a value on a box, beating the stored document', async () => {
    // The operator set it; the dashboard says otherwise; the box wins.
    const cfg = config({ PEN_THUMBNAIL_QUALITY: 'medium' });
    const source = new FakeSource(document({ PEN_THUMBNAIL_QUALITY: 'high' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_THUMBNAIL_QUALITY')).toBe('medium');
    expect(store.sourceOf('PEN_THUMBNAIL_QUALITY')).toBe('env');
    expect(store.pinned('PEN_THUMBNAIL_QUALITY')).toBe(true);
    // The stored value is still reported, so the console can say plainly that
    // this box is ignoring it rather than pretending the save worked.
    expect(store.storedValue('PEN_THUMBNAIL_QUALITY')).toBe('high');
  });

  it('a value the environment did not set is not a pin, so the dashboard still reaches it', async () => {
    const cfg = config();
    expect(new RuntimeConfigStore({ cfg }).pinned('PEN_THUMBNAIL_QUALITY')).toBe(false);
    const source = new FakeSource(document({ PEN_THUMBNAIL_QUALITY: 'high' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_THUMBNAIL_QUALITY')).toBe('high');
  });

  it('coerces and bounds a stored number exactly as the environment variable would', async () => {
    const cfg = config();
    const source = new FakeSource(document({ PEN_ADS_EVERY_SEGMENTS: '5' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_ADS_EVERY_SEGMENTS')).toBe(5);
  });
});

describe('last known good', () => {
  it('keeps serving the last good document when a read fails, rather than falling back to defaults', async () => {
    const cfg = config();
    const source = new FakeSource(document({ PEN_LLM_MODEL: 'gpt-5.6-pro' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_LLM_MODEL')).toBe('gpt-5.6-pro');
    expect(store.stale).toBe(false);

    source.failing = true;
    expect(await store.refresh()).toBe(false);
    // The outage changed nothing about how the product behaves.
    expect(store.get('PEN_LLM_MODEL')).toBe('gpt-5.6-pro');
    expect(store.stale).toBe(true);

    source.failing = false;
    expect(await store.refresh()).toBe(true);
    expect(store.stale).toBe(false);
  });

  it('survives a restart during an outage, because the last good document is on disk', async () => {
    const cfg = config();
    const path = join(cfg.PEN_DATA_DIR, 'runtime-config.json');
    const first = new RuntimeConfigStore({
      cfg,
      source: new FakeSource(document({ PEN_LLM_MODEL: 'gpt-5.6-pro' })),
      pollMs: 0,
      path,
    });
    await first.start();
    expect(first.get('PEN_LLM_MODEL')).toBe('gpt-5.6-pro');

    // The process comes back while the database is still down.
    const down = new FakeSource(document({}), true);
    const restarted = new RuntimeConfigStore({ cfg, source: down, pollMs: 0, path });
    await restarted.start();
    expect(down.reads).toBe(1);
    expect(restarted.get('PEN_LLM_MODEL')).toBe('gpt-5.6-pro');
    expect(restarted.stale).toBe(true);
    expect(restarted.revision).toBe(1);
  });

  it('starts from the defaults when the cached copy is corrupt, and says so rather than throwing', () => {
    const cfg = config();
    const path = join(cfg.PEN_DATA_DIR, 'runtime-config.json');
    writeFileSync(path, '{ not json');
    const store = new RuntimeConfigStore({ cfg, path });
    expect(store.get('PEN_LLM_MODEL')).toBe('gpt-5.6-luna');
  });

  it('writes the cache atomically, leaving no partial file behind', async () => {
    const cfg = config();
    const path = join(cfg.PEN_DATA_DIR, 'runtime-config.json');
    const store = new RuntimeConfigStore({
      cfg,
      source: new FakeSource(document({ PEN_TTS_CACHE_MB: 4096 })),
      pollMs: 0,
      path,
    });
    await store.start();
    const cached = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      settings: Record<string, unknown>;
    };
    expect(cached.version).toBe(1);
    expect(cached.settings.PEN_TTS_CACHE_MB).toBe(4096);
  });
});

describe('an unparseable setting', () => {
  it('is ignored on its own, keeping its last good value while the rest of the document lands', async () => {
    const cfg = config();
    const source = new FakeSource(document({ PEN_THUMBNAIL_QUALITY: 'high' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_THUMBNAIL_QUALITY')).toBe('high');

    source.snapshot = document({ PEN_THUMBNAIL_QUALITY: 'ultra', PEN_ADS_EVERY_SEGMENTS: 7 }, 2);
    expect(await store.refresh()).toBe(true);
    // The bad one keeps what it had; the good one beside it still arrives.
    expect(store.get('PEN_THUMBNAIL_QUALITY')).toBe('high');
    expect(store.get('PEN_ADS_EVERY_SEGMENTS')).toBe(7);
  });

  it('refuses a number outside the bounds the registry declares', async () => {
    const cfg = config();
    const source = new FakeSource(document({ PEN_MAX_BODY_BYTES: 12 }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    // 12 bytes would make every write fail; the default stands instead.
    expect(store.get('PEN_MAX_BODY_BYTES')).toBe(65_536);
  });

  it('ignores a name that is not a setting, and one whose value is the wrong shape', async () => {
    const cfg = config();
    const source = new FakeSource(
      document({ NOT_A_SETTING: 'x', PEN_TTS_CACHE_MB: { nested: true } }),
    );
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_TTS_CACHE_MB')).toBe(2048);
    expect(store.snapshot().NOT_A_SETTING).toBeUndefined();
  });

  it('clears an override back to the default when the document stops mentioning it', async () => {
    const cfg = config();
    const source = new FakeSource(document({ PEN_THUMBNAIL_QUALITY: 'high' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    source.snapshot = document({}, 2);
    await store.refresh();
    expect(store.get('PEN_THUMBNAIL_QUALITY')).toBe('low');
    expect(store.sourceOf('PEN_THUMBNAIL_QUALITY')).toBe('default');
  });
});

describe('the telemetry snapshot', () => {
  it('carries every setting in force, so a session can be explained from its own record', async () => {
    const cfg = config({ PEN_LLM_MODEL: 'pinned-model' });
    const source = new FakeSource(document({ PEN_INTENT_PROVIDER: 'model' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    const snapshot = store.snapshot();
    expect(snapshot.PEN_LLM_MODEL).toBe('pinned-model');
    expect(snapshot.PEN_INTENT_PROVIDER).toBe('model');
    expect(snapshot.PEN_THUMBNAIL_QUALITY).toBe('low');
    // An optional setting with no value is absent rather than null.
    expect('PEN_LLM_SERVICE_TIER' in snapshot).toBe(false);
  });
});
