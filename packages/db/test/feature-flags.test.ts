import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Connection, connect, FeatureFlagsRepository } from '../src/index.js';

/**
 * The feature-flag document (ADR-0036) keeps the runtime configuration's two
 * promises: a save is a compare-and-set, and the history only grows.
 */
let conn: Connection;
let repo: FeatureFlagsRepository;

beforeAll(async () => {
  conn = await connect('pglite://memory');
  repo = new FeatureFlagsRepository(conn.db);
});
afterAll(async () => {
  await conn.close();
});

const author = { updatedBy: 'p_admin', updatedByName: 'Sam Owner' };
const openToFree = {
  prepare_new_topics: { default: true, plans: {}, platforms: {}, cells: {} },
};

describe('the singleton document', () => {
  it('reads as revision 0 before anything was written', async () => {
    expect(await repo.read()).toEqual({ revision: 0, rules: {}, updatedAt: 0, updatedBy: null });
  });

  it('creates itself on the first save and moves one revision at a time', async () => {
    const first = await repo.write(
      { expectedRevision: 0, rules: openToFree, reason: 'launch week', ...author },
      1_000,
    );
    expect(first).toMatchObject({ ok: true });
    expect(await repo.read()).toEqual({
      revision: 1,
      rules: openToFree,
      updatedAt: 1_000,
      updatedBy: 'p_admin',
    });
  });

  it('refuses a stale revision and says what is in force', async () => {
    const stale = await repo.write({
      expectedRevision: 0,
      rules: {},
      reason: 'stale',
      ...author,
    });
    expect(stale).toEqual({ ok: false, current: 1 });
    expect((await repo.read()).rules).toEqual(openToFree);
    expect((await repo.history()).entries).toHaveLength(1);
  });

  it('lets exactly one of two racing writers through', async () => {
    const at = (await repo.read()).revision;
    const results = await Promise.all([
      repo.write({ expectedRevision: at, rules: { a: 1 }, reason: 'a', ...author }),
      repo.write({ expectedRevision: at, rules: { b: 1 }, reason: 'b', ...author }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await repo.read()).revision).toBe(at + 1);
  });

  it('keeps every revision in the history, newest first, and records a rollback source', async () => {
    const at = (await repo.read()).revision;
    await repo.write({
      expectedRevision: at,
      rules: {},
      reason: 'back to defaults',
      restoredFromRevision: 0,
      ...author,
    });
    const page = await repo.history({ limit: 2 });
    expect(page.entries.map((e) => e.revision)).toEqual([at + 1, at]);
    expect(page.entries[0]?.restoredFromRevision).toBe(0);
    expect(page.nextBeforeRevision).toBe(at);
    expect((await repo.audit(1))?.rules).toEqual(openToFree);
  });
});
