import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import {
  applyMigrations,
  connect,
  migrationsFolder,
  reconcileMigrationTimestamps,
  schema,
} from '../src/index.js';

const folder = migrationsFolder();

async function appliedRows(db: ReturnType<typeof drizzle<typeof schema>>) {
  const res = await db.execute(
    sql`select hash, created_at from "drizzle"."__drizzle_migrations" order by id`,
  );
  return (res.rows as Array<{ hash: string; created_at: unknown }>).map((r) => ({
    hash: r.hash,
    createdAt: Number(r.created_at),
  }));
}

describe('migration timestamp guard', () => {
  it('a regenerated journal (newer `when`, same SQL) no longer re-runs an applied migration', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    const logged: Array<Record<string, unknown>> = [];
    await applyMigrations(db, 'pglite', folder, (_m, detail) => logged.push(detail));
    expect(logged).toEqual([]);
    const journal = readMigrationFiles({ migrationsFolder: folder });
    const first = journal[0];
    if (!first) throw new Error('no migrations');
    const before = await appliedRows(db);
    expect(before.map((r) => r.hash)).toEqual(journal.map((m) => m.hash));

    // Simulate drizzle-kit having rewritten the journal after this database was migrated:
    // the applied row is now older than the journal's `when` for the very same SQL.
    await db.execute(
      sql`update "drizzle"."__drizzle_migrations" set created_at = ${first.folderMillis - 60_000} where hash = ${first.hash}`,
    );
    // Without the guard Drizzle would replay 0000 and die on "relation already exists".
    await expect(
      applyMigrations(db, 'pglite', folder, (_m, detail) => logged.push(detail)),
    ).resolves.toBeUndefined();
    expect(logged).toEqual([
      { hash: first.hash, createdAt: first.folderMillis - 60_000, when: first.folderMillis },
    ]);
    const after = await appliedRows(db);
    expect(after).toEqual(before);
    // Still one row per migration: nothing was applied twice.
    expect(after).toHaveLength(journal.length);
    // The table it would have recreated is intact and usable.
    const ok = await db.execute(sql`select count(*)::int as n from participants`);
    expect((ok.rows[0] as { n: number }).n).toBe(0);
    await client.close();
  });

  it('leaves rows alone when the database is ahead of or equal to the journal', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await applyMigrations(db, 'pglite', folder);
    const before = await appliedRows(db);
    expect(await reconcileMigrationTimestamps(db, folder)).toEqual([]);
    // A row newer than the journal (e.g. a migration the checkout does not have yet) is untouched.
    await db.execute(
      sql`update "drizzle"."__drizzle_migrations" set created_at = created_at + 1000`,
    );
    expect(await reconcileMigrationTimestamps(db, folder)).toEqual([]);
    expect((await appliedRows(db)).map((r) => r.createdAt)).toEqual(
      before.map((r) => r.createdAt + 1000),
    );
    await client.close();
  });

  it('is a no-op on a fresh database (no migrations table yet)', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    expect(await reconcileMigrationTimestamps(db, folder)).toEqual([]);
    await client.close();
  });

  it('connect() reports reconciliations through its log seam', async () => {
    const logs: string[] = [];
    const conn = await connect('pglite://memory', { log: (m) => logs.push(m) });
    expect(logs).toEqual([]);
    await conn.close();
  });
});
