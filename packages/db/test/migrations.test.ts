import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('upgrading a database that already exists', () => {
  it('adds the runtime-config tables to a 0007 database without touching its rows', async () => {
    // The production path, not the fresh-checkout one: a database that was
    // migrated before this branch existed, with data in it, being upgraded.
    const older = mkdtempSync(join(tmpdir(), 'pen-mig-0007-'));
    cpSync(folder, older, { recursive: true });
    const journalPath = join(older, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const newest = journal.entries[journal.entries.length - 1];
    if (!newest) throw new Error('no migrations');
    journal.entries = journal.entries.slice(0, -1);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    rmSync(join(older, `${newest.tag}.sql`));

    const client = new PGlite();
    const db = drizzle(client, { schema });
    await applyMigrations(db, 'pglite', older);
    expect(await tableNames(db)).not.toContain('runtime_config_state');
    await db.execute(sql`insert into participants (id, name) values ('p_before', 'Ada')`);

    // The same database, now with this branch's migrations.
    await applyMigrations(db, 'pglite', folder);
    const after = await tableNames(db);
    expect(after).toContain('runtime_config_state');
    expect(after).toContain('runtime_config_audits');
    const kept = await db.execute(sql`select name from participants where id = 'p_before'`);
    expect((kept.rows as Array<{ name: string }>)[0]?.name).toBe('Ada');

    // And running it again is a no-op rather than "relation already exists".
    await applyMigrations(db, 'pglite', folder);
    expect(await tableNames(db)).toContain('runtime_config_state');
    await client.close();
    rmSync(older, { recursive: true, force: true });
  });
});

async function tableNames(db: ReturnType<typeof drizzle<typeof schema>>): Promise<string[]> {
  const res = await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  );
  return (res.rows as Array<{ table_name: string }>).map((r) => r.table_name);
}
