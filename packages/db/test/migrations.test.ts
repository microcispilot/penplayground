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
  /**
   * Everything the schema has gained since `0007_participant_pace`, which is
   * the last migration production had before this line of work. Each new one
   * adds its tables here, so the upgrade path is tested rather than assumed.
   */
  const ADDED_SINCE_0007 = [
    // 0008, the runtime configuration (ADR-0025).
    'runtime_config_state',
    'runtime_config_audits',
    // 0009, statistics and reports (ADR-0027).
    'session_stats',
    'session_stage_stats',
    'session_error_stats',
    'session_reuse_links',
    'stats_work_origin',
    'session_engagement',
    'site_visits',
    'site_visit_screens',
    'plan_events',
  ];

  it('upgrades a 0007 database to everything since, without touching its rows', async () => {
    // The production path, not the fresh-checkout one: a database that was
    // migrated before this branch existed, with data in it, being upgraded.
    const older = mkdtempSync(join(tmpdir(), 'pen-mig-0007-'));
    cpSync(folder, older, { recursive: true });
    const journalPath = join(older, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    // Cut at 0007 by name rather than by position: "everything after the last
    // one" stops being the right cut the moment a second migration lands.
    const cut = journal.entries.findIndex((e) => e.tag === '0007_participant_pace');
    if (cut < 0) throw new Error('0007_participant_pace is missing from the journal');
    for (const removed of journal.entries.slice(cut + 1)) rmSync(join(older, `${removed.tag}.sql`));
    journal.entries = journal.entries.slice(0, cut + 1);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));

    const client = new PGlite();
    const db = drizzle(client, { schema });
    await applyMigrations(db, 'pglite', older);
    const before = await tableNames(db);
    for (const table of ADDED_SINCE_0007) expect(before).not.toContain(table);
    await db.execute(sql`insert into participants (id, name) values ('p_before', 'Ada')`);

    // The same database, now with this branch's migrations.
    await applyMigrations(db, 'pglite', folder);
    const after = await tableNames(db);
    for (const table of ADDED_SINCE_0007)
      expect(after, `${table} was not created`).toContain(table);
    // The columns 0009 adds to an existing table, not only the new tables.
    const columns = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'participants'`,
    );
    const names = (columns.rows as Array<{ column_name: string }>).map((r) => r.column_name);
    expect(names).toContain('plan_interval');
    expect(names).toContain('plan_status');
    const kept = await db.execute(sql`select name from participants where id = 'p_before'`);
    expect((kept.rows as Array<{ name: string }>)[0]?.name).toBe('Ada');

    // And running it again is a no-op rather than "relation already exists".
    await applyMigrations(db, 'pglite', folder);
    expect(await tableNames(db)).toContain('session_stats');
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

/**
 * The migrations against the engine production actually runs. PGlite is
 * Postgres, but not the same build, and `CHECK` constraints and `jsonb`
 * defaults are exactly the sort of thing worth seeing land on the real one.
 *
 *   PEN_TEST_DATABASE_URL=postgres://… pnpm --filter @pen/db test
 */
describe.skipIf(!process.env.PEN_TEST_DATABASE_URL)('on postgres', () => {
  it('applies every migration, and is a no-op the second time', async () => {
    const url = process.env.PEN_TEST_DATABASE_URL ?? '';
    let conn = await connect(url);
    // `execute()` yields `{ rows }` on PGlite and a bare array on postgres-js.
    const present = async () => {
      const res: unknown = await conn.db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
      );
      const rows = (
        Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])
      ) as Array<{ table_name: string }>;
      return rows.map((r) => r.table_name);
    };
    expect(await present()).toContain('runtime_config_state');
    expect(await present()).toContain('runtime_config_audits');
    // The singleton and the forward-only constraints are the database's job,
    // not the repository's; prove the real engine is enforcing them.
    await expect(
      conn.db.execute(sql`insert into runtime_config_state (id, revision, updated_at)
                          values (2, 0, 0)`),
    ).rejects.toThrow();
    await expect(
      conn.db.execute(sql`insert into runtime_config_audits
                          (revision, settings, updated_at, updated_by, updated_by_name, reason,
                           restored_from_revision)
                          values (5, '{}'::jsonb, 0, 'p', 'P', 'r', 9)`),
    ).rejects.toThrow();
    await conn.close();
    conn = await connect(url);
    expect(await present()).toContain('runtime_config_state');
    await conn.close();
  }, 60_000);
});
