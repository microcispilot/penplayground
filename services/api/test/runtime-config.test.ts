import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeConfigSnapshot } from '@pen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { Env, loadConfig } from '../src/config.js';
import {
  NOT_SETTINGS,
  RuntimeConfigStore,
  SETTING_NAMES,
  SHAPES,
} from '../src/runtime-config/index.js';

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
    // Before it has tried to read, it is already serving the cached document
    // and does not yet claim the database failed — that claim is `refresh`'s
    // to make, and making it here would swallow its one warning.
    expect(restarted.get('PEN_LLM_MODEL')).toBe('gpt-5.6-pro');
    expect(restarted.stale).toBe(false);

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
    const source = new FakeSource(document({ PEN_TTS_CACHE_MB: 4096 }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0, path });
    await store.start();
    const cached = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      settings: Record<string, unknown>;
    };
    expect(cached.version).toBe(1);
    expect(cached.settings.PEN_TTS_CACHE_MB).toBe(4096);
    // Atomic means no temporary file survives the write — a reader that
    // found one and a torn one would be the same accident.
    expect(readdirSync(cfg.PEN_DATA_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rewrites the cache only when the document moved, not on every poll', async () => {
    // The poll runs every few seconds for a document that changes monthly.
    const cfg = config();
    const path = join(cfg.PEN_DATA_DIR, 'runtime-config.json');
    const source = new FakeSource(document({ PEN_TTS_CACHE_MB: 4096 }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0, path });
    await store.start();
    const first = statSync(path).mtimeMs;
    for (let i = 0; i < 3; i += 1) await store.refresh();
    expect(statSync(path).mtimeMs).toBe(first);

    source.snapshot = document({ PEN_TTS_CACHE_MB: 8192 }, 2);
    await store.refresh();
    const after = JSON.parse(readFileSync(path, 'utf8')) as { settings: Record<string, unknown> };
    expect(after.settings.PEN_TTS_CACHE_MB).toBe(8192);
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

describe('an environment pin cannot be beaten', () => {
  it('holds even when the pin itself is out of bounds, rather than letting a save win', async () => {
    // The bounds live on the schema, so `loadConfig` refuses a pin like this
    // and the process never boots with one. If one ever reaches here anyway,
    // the stored tier still must not take over a setting the operator pinned.
    const cfg = config();
    const source = new FakeSource(document({ PEN_DAILY_SPEND_CAP_USD: 5 }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    // Not pinned here, so the save lands.
    expect(store.get('PEN_DAILY_SPEND_CAP_USD')).toBe(5);

    const pinned = config({ PEN_DAILY_SPEND_CAP_USD: '900' });
    const pinnedStore = new RuntimeConfigStore({ cfg: pinned, source, pollMs: 0 });
    await pinnedStore.start();
    expect(pinnedStore.get('PEN_DAILY_SPEND_CAP_USD')).toBe(900);
    expect(pinnedStore.sourceOf('PEN_DAILY_SPEND_CAP_USD')).toBe('env');
  });

  it('refuses at boot a pin the console would also refuse', () => {
    // One set of bounds, on the schema, so the two tiers cannot disagree
    // about what a legal value is.
    expect(() => config({ PEN_DAILY_SPEND_CAP_USD: '200000' })).toThrow(/PEN_DAILY_SPEND_CAP_USD/);
    expect(() => config({ PEN_MAX_BODY_BYTES: '12' })).toThrow(/PEN_MAX_BODY_BYTES/);
    expect(() => config({ PEN_ADS_EVERY_SEGMENTS: '99' })).toThrow(/PEN_ADS_EVERY_SEGMENTS/);
    expect(() => config({ PEN_LLM_MODEL: '   ' })).toThrow(/PEN_LLM_MODEL/);
  });

  it('reports the schema default, not whatever this box happens to set', () => {
    const cfg = config({ PEN_DAILY_SPEND_CAP_USD: '900' });
    const store = new RuntimeConfigStore({ cfg });
    expect(store.get('PEN_DAILY_SPEND_CAP_USD')).toBe(900);
    // The console shows this beside it as "Default", and it must be the
    // number the code runs on with no override anywhere — not this box's.
    expect(store.defaultValue('PEN_DAILY_SPEND_CAP_USD')).toBe(25);
  });
});

describe('a value this deployment must not run on', () => {
  it('is dropped when read, so a save made elsewhere cannot kill the next boot', async () => {
    // No Fish key on this box. `buildServices` throws on `fish-cloud`, and
    // that throw would happen at boot — long after the save that caused it.
    const cfg = config();
    const source = new FakeSource(document({ PEN_TTS_PROVIDER: 'fish-cloud' }));
    const store = new RuntimeConfigStore({ cfg, source, pollMs: 0 });
    await store.start();
    expect(store.get('PEN_TTS_PROVIDER')).toBe('silent');
    expect(store.sourceOf('PEN_TTS_PROVIDER')).toBe('env');

    // Same with server-side speech: a stored provider with no key is ignored.
    const noPin = loadConfig({
      NODE_ENV: 'test',
      PEN_JWT_SECRET: 'x'.repeat(40),
      PEN_DATA_DIR: tempDir(),
      PEN_LLM_PROVIDER: 'fake',
    });
    const sttStore = new RuntimeConfigStore({
      cfg: noPin,
      source: new FakeSource(document({ PEN_STT_PROVIDER: 'deepgram' })),
      pollMs: 0,
    });
    await sttStore.start();
    expect(sttStore.get('PEN_STT_PROVIDER')).toBe('browser');
  });

  it('never lets a stored value bypass the production refusals', async () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      PEN_JWT_SECRET: 'x'.repeat(40),
      PEN_DATA_DIR: tempDir(),
      PEN_PUBLIC_URL: 'https://pen.test',
      PEN_API_URL: 'https://pen.test',
      OPENAI_API_KEY_FREE: 'k',
      OPENAI_API_KEY_STANDARD: 'k',
      OPENAI_API_KEY_PROFESSIONAL: 'k',
      FISH_AUDIO_API_KEY: 'k',
    });
    const store = new RuntimeConfigStore({
      cfg,
      source: new FakeSource(document({ PEN_LLM_PROVIDER: 'fake', PEN_TTS_PROVIDER: 'silent' })),
      pollMs: 0,
    });
    await store.start();
    // `loadConfig` refuses both of these in production, and a stored value
    // arrives after that check has run. Scripted lessons and a silent expert
    // are exactly what a paying learner must never get.
    expect(store.get('PEN_LLM_PROVIDER')).toBe('openai');
    // `fish-cloud` is the old name of `cloud` (ADR-0048): read back as what it means.
    expect(store.get('PEN_TTS_PROVIDER')).toBe('cloud');
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

describe('the catalogue', () => {
  it('accounts for every environment variable, so a new one cannot be forgotten', () => {
    // The decision "is this a setting?" is made once, in code, for every
    // variable — not in a document that quietly stops being true. A variable
    // added to config.ts fails here until somebody has said which side of the
    // line it is on (ADR-0025).
    const known = new Set<string>([...SETTING_NAMES, ...Object.keys(NOT_SETTINGS)]);
    const unclassified = Object.keys(Env.shape).filter((name) => !known.has(name));
    expect(unclassified).toEqual([]);
    // And nothing is on both sides.
    expect(SETTING_NAMES.filter((name) => name in NOT_SETTINGS)).toEqual([]);
  });

  it('never exposes a secret, an address or a development-only switch as a setting', () => {
    // A second, independent reading of the same rule: whatever the reasons
    // say, no setting may be named like a credential or a location.
    const forbidden = /KEY|SECRET|TOKEN|DSN|PASSWORD|_URL$|_PATH$|DATABASE|ADMIN_EMAILS/;
    expect(SETTING_NAMES.filter((name) => forbidden.test(name))).toEqual([]);
  });

  it('finds the choices the schema declares, and offers exactly those', () => {
    // `shapeOf` peels `.default()`/`.optional()` off a field by matching on
    // zod's internal `def.type`. If a zod upgrade ever stops it peeling,
    // every dropdown silently becomes a free-text box — so this names the
    // choices it must find rather than asking the schema to agree with
    // itself.
    expect(SHAPES.PEN_THUMBNAIL_QUALITY.options).toEqual(['low', 'medium', 'high']);
    expect(SHAPES.PEN_INTENT_PROVIDER.options).toEqual(['model', 'jev']);
    expect(SHAPES.PEN_LLM_SERVICE_TIER.options).toEqual([
      'unset',
      'auto',
      'default',
      'flex',
      'priority',
    ]);
    expect(SHAPES.PEN_LLM_MODEL.kind).toBe('text');
    expect(SHAPES.PEN_TTS_CACHE_MB.kind).toBe('number');
    // And the kinds line up with the options everywhere.
    for (const name of SETTING_NAMES) {
      const shape = SHAPES[name];
      expect(shape.kind === 'choice', name).toBe(shape.options !== undefined);
      if (shape.options) expect(shape.parse('definitely-not-a-value').ok, name).toBe(false);
    }
  });
});

/**
 * Every numeric setting is `z.coerce.number()`, and JavaScript's coercion
 * says `Number('') === 0`. So a number field left blank in the console did
 * not fail validation: it saved a zero.
 *
 * Which is not a harmless zero. `PEN_DAILY_SPEND_CAP_USD` is the circuit
 * breaker on real provider spend and `SpendBreaker.enabled` is `capUsd() > 0`
 * (`services/api/src/spend.ts:60`), so an empty field turns the breaker off —
 * and the row then reads "0" as though somebody meant it. `PEN_TTS_CACHE_MB:
 * ''` turns off the lesson voice store the same way, and every repeat lesson
 * is re-synthesised at full price.
 *
 * The three that were reachable are the three whose `min` is 0; the rest were
 * saved only by a `min: 1` that has nothing to do with the coercion. The
 * whitespace, boolean and array forms coerce to 0 too.
 */
describe('a number field that was left blank', () => {
  const emptyish: unknown[] = ['', '   ', '\t', false, [], null];

  it('is refused rather than saved as zero', () => {
    for (const name of SETTING_NAMES) {
      const shape = SHAPES[name];
      if (shape.kind !== 'number') continue;
      for (const value of emptyish) {
        const parsed = shape.parse(value);
        // `null` on an optional field legitimately means "no value".
        if (value === null && shape.nullable) {
          expect(parsed, `${name} / null`).toEqual({ ok: true, value: undefined });
          continue;
        }
        expect(parsed.ok, `${name} / ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it('still takes the numbers an operator actually types', () => {
    expect(SHAPES.PEN_DAILY_SPEND_CAP_USD.parse(0)).toEqual({ ok: true, value: 0 });
    expect(SHAPES.PEN_DAILY_SPEND_CAP_USD.parse('0')).toEqual({ ok: true, value: 0 });
    expect(SHAPES.PEN_DAILY_SPEND_CAP_USD.parse('12.5')).toEqual({ ok: true, value: 12.5 });
    expect(SHAPES.PEN_DAILY_SPEND_CAP_USD.parse(' 12.5 ')).toEqual({ ok: true, value: 12.5 });
    expect(SHAPES.PEN_TTS_CACHE_MB.parse('2048')).toEqual({ ok: true, value: 2048 });
    expect(SHAPES.PEN_DAILY_SPEND_CAP_USD.parse('abc').ok).toBe(false);
    expect(SHAPES.PEN_DAILY_SPEND_CAP_USD.parse('12abc').ok).toBe(false);
  });
});
