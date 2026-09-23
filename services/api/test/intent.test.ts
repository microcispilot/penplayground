import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createIntentClassifier } from '../src/intent.js';
import { RuntimeConfigStore } from '../src/runtime-config/index.js';

/**
 * The intent seam after ADR-0025 made its provider a runtime setting: `jev`
 * ships on, the room reads the choice once as it is built, and a missing key
 * is a configuration to fix rather than a refusal to build rooms.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pen-intent-'));
  dirs.push(dataDir);
  return loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    ...env,
  });
}

/** The factory as `buildServices` makes it, over a store with nothing stored. */
function factory(env: Record<string, string> = {}) {
  const cfg = config(env);
  const store = new RuntimeConfigStore({ cfg });
  return { store, intentFor: createIntentClassifier(cfg, store) };
}

describe('the hosted intent classifier', () => {
  it('is what a room gets by default, when there is a key to run it on', () => {
    const { intentFor } = factory({ OPENROUTER_API_KEY: 'sk-or-test' });
    const classifier = intentFor();
    expect(classifier).not.toBeNull();
    expect(classifier?.id).toContain('jev');
  });

  it('returns null rather than throwing when `jev` has no key, so rooms still build', () => {
    // This used to be fatal at boot. It cannot stay fatal once the provider
    // is something a console can change: the room owns the model path and
    // always has it, so a missing key is slower turns, never a dead product.
    const { intentFor } = factory();
    expect(intentFor()).toBeNull();
    // Idempotent, and it does not start throwing on the second room either.
    expect(intentFor()).toBeNull();
  });

  it('gives the session model the work when the provider says `model`', () => {
    const { intentFor } = factory({
      PEN_INTENT_PROVIDER: 'model',
      OPENROUTER_API_KEY: 'sk-or-test',
    });
    expect(intentFor()).toBeNull();
  });

  it('memoises per provider and model, so building a room costs a lookup', () => {
    const { intentFor } = factory({ OPENROUTER_API_KEY: 'sk-or-test' });
    expect(intentFor()).toBe(intentFor());
  });

  it('follows the setting between rooms, and keeps one classifier per model', async () => {
    const cfg = config({ OPENROUTER_API_KEY: 'sk-or-test' });
    const store = new RuntimeConfigStore({
      cfg,
      source: {
        read: async () => ({
          revision: 1,
          settings: { PEN_INTENT_MODEL: 'typesafe/jev-1.14' },
          updatedAt: 1,
          updatedBy: 'p_admin',
        }),
      },
      pollMs: 0,
    });
    const intentFor = createIntentClassifier(cfg, store);
    const before = intentFor();
    await store.start();
    const after = intentFor();
    // A different model is a different classifier; the old one is not reused.
    expect(after).not.toBe(before);
    expect(after?.id).toContain('1.14');
    // And back again reuses the first one rather than building a third.
    store.apply({ revision: 2, settings: {}, updatedAt: 2, updatedBy: 'p' }, 'database');
    expect(intentFor()).toBe(before);
  });
});

/**
 * Which endpoint the room actually talks to.
 *
 * The model id belongs to the *route*, not to the model, and that is the whole
 * reason this is tested rather than left to a comment: TypeSafe refuses
 * `typesafe/jev-1.13` and OpenRouter refuses `jev-latest`, both with a 400, so
 * a build that picks one key and the other id is configured, looks configured,
 * and fails every classification — silently, because intent falls back to the
 * session model on any error.
 */
describe('the route to Jev', () => {
  it('prefers TypeSafe direct when its key is present, and uses its own id', () => {
    const { intentFor } = factory({
      PEN_TYPESAFE_API_KEY: 'ts-key',
      OPENROUTER_API_KEY: 'or-key',
      PEN_INTENT_MODEL: 'typesafe/jev-1.13',
    });
    const classifier = intentFor();
    expect(classifier).not.toBeNull();
    // The gateway's pinned id must NOT have followed us to TypeSafe.
    expect(classifier?.id).toBe('jev-latest');
  });

  it('falls back to the gateway, with the gateway\u2019s pinned id', () => {
    const { intentFor } = factory({
      OPENROUTER_API_KEY: 'or-key',
      PEN_INTENT_MODEL: 'typesafe/jev-1.13',
    });
    expect(intentFor()?.id).toBe('typesafe/jev-1.13');
  });

  it('classifies with the session model when neither key is set', () => {
    expect(factory().intentFor()).toBeNull();
  });
});
