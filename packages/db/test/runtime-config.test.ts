import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Connection, connect, RuntimeConfigRepository } from '../src/index.js';

/**
 * The two properties the settings console depends on (ADR-0025): a save is a
 * compare-and-set, and the history it writes can only grow.
 */

let conn: Connection;
let repo: RuntimeConfigRepository;

beforeAll(async () => {
  conn = await connect('pglite://memory');
  repo = new RuntimeConfigRepository(conn.db);
});
afterAll(async () => {
  await conn.close();
});

const author = { updatedBy: 'p_admin', updatedByName: 'Sam Owner' };

describe('the singleton document', () => {
  it('reads as revision 0 before anything has ever been written', async () => {
    expect(await repo.read()).toEqual({
      revision: 0,
      settings: {},
      updatedAt: 0,
      updatedBy: null,
    });
  });

  it('creates itself on the first save and moves one revision at a time', async () => {
    const first = await repo.write(
      { expectedRevision: 0, settings: { a: 1 }, reason: 'first', ...author },
      1_000,
    );
    expect(first).toMatchObject({ ok: true });
    expect(await repo.read()).toEqual({
      revision: 1,
      settings: { a: 1 },
      updatedAt: 1_000,
      updatedBy: 'p_admin',
    });

    const second = await repo.write(
      { expectedRevision: 1, settings: { a: 2 }, reason: 'second', ...author },
      2_000,
    );
    expect(second).toMatchObject({ ok: true });
    expect((await repo.read()).revision).toBe(2);
  });
});

describe('compare and set', () => {
  it('refuses a stale revision and says what is actually in force', async () => {
    const stale = await repo.write({
      expectedRevision: 1,
      settings: { a: 99 },
      reason: 'stale',
      ...author,
    });
    expect(stale).toEqual({ ok: false, current: 2 });
    // Nothing moved, and nothing was appended to the history.
    expect((await repo.read()).settings).toEqual({ a: 2 });
    expect((await repo.history({ limit: 50 })).entries.map((e) => e.revision)).toEqual([2, 1]);
  });

  it('lets exactly one of two writers racing on the same revision through', async () => {
    const at = (await repo.read()).revision;
    const results = await Promise.all([
      repo.write({ expectedRevision: at, settings: { who: 'a' }, reason: 'a', ...author }),
      repo.write({ expectedRevision: at, settings: { who: 'b' }, reason: 'b', ...author }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    const after = await repo.read();
    expect(after.revision).toBe(at + 1);
    // And the history has exactly one new row, not two.
    const page = await repo.history({ limit: 50 });
    expect(page.entries.filter((e) => e.revision === at + 1)).toHaveLength(1);
  });
});

describe('the audit trail', () => {
  it('records who, when, why, and what a rollback restored', async () => {
    const at = (await repo.read()).revision;
    await repo.write(
      {
        expectedRevision: at,
        settings: { a: 2 },
        reason: 'back to revision 2',
        restoredFromRevision: 2,
        ...author,
      },
      9_000,
    );
    const page = await repo.history({ limit: 1 });
    expect(page.entries[0]).toMatchObject({
      revision: at + 1,
      updatedBy: 'p_admin',
      updatedByName: 'Sam Owner',
      reason: 'back to revision 2',
      restoredFromRevision: 2,
      updatedAt: 9_000,
      settings: { a: 2 },
    });
    // Forward only: the revision it restored is still there, untouched.
    expect(await repo.audit(2)).toMatchObject({ revision: 2, settings: { a: 2 } });
  });

  it('pages newest first and only offers another page when there is one', async () => {
    const all = await repo.history({ limit: 50 });
    const revisions = all.entries.map((e) => e.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => b - a));
    expect(all.nextBeforeRevision).toBeNull();

    const first = await repo.history({ limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextBeforeRevision).toBe(first.entries[1]?.revision);
    const next = await repo.history({ beforeRevision: first.nextBeforeRevision, limit: 2 });
    expect(next.entries[0]?.revision).toBeLessThan(first.nextBeforeRevision ?? 0);
  });
});
