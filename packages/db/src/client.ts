import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>;

/**
 * Where the Drizzle migrations live. `PEN_MIGRATIONS_DIR` wins; otherwise the folder next to
 * this package's source (`packages/db/drizzle`), else one beside the module itself — which is
 * where a production bundle (`services/api/dist/main.js` + `dist/drizzle`) keeps its copy.
 */
export function migrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PEN_MIGRATIONS_DIR?.trim();
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, '..', 'drizzle');
  const bundled = join(here, 'drizzle');
  return existsSync(join(bundled, 'meta', '_journal.json')) ? bundled : source;
}

export interface Connection {
  db: Database;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

export interface ReconciledMigration {
  hash: string;
  /** What the database had recorded. */
  createdAt: number;
  /** What the journal says now; the row is updated to this. */
  when: number;
}

/** `execute()` yields `{ rows }` on PGlite and a bare row array on postgres-js. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const boxed = result as { rows?: unknown };
  return Array.isArray(boxed.rows) ? (boxed.rows as T[]) : [];
}

/**
 * Drizzle decides what to apply by timestamp alone: every journal entry whose
 * `when` is newer than the last applied row's `created_at` runs. A regenerated
 * journal (drizzle-kit rewriting `when` for an unchanged migration) therefore
 * makes an existing database re-run a migration it already has, and the boot
 * dies on "relation already exists". Before migrating, rows whose hash matches
 * a journal entry — the very same SQL — are moved forward to the journal's
 * `when`, so identity is decided by content, not by the clock. Returns what
 * was reconciled so callers can log it.
 */
export async function reconcileMigrationTimestamps(
  db: Database,
  folder: string,
): Promise<ReconciledMigration[]> {
  const table = sql`"drizzle"."__drizzle_migrations"`;
  const present = rowsOf<{ name: string | null }>(
    await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') as name`),
  );
  if (!present[0]?.name) return [];
  const applied = rowsOf<{ id: number; hash: string; created_at: unknown }>(
    await db.execute(sql`select id, hash, created_at from ${table}`),
  );
  const byHash = new Map(
    readMigrationFiles({ migrationsFolder: folder }).map((m) => [m.hash, m.folderMillis] as const),
  );
  const reconciled: ReconciledMigration[] = [];
  for (const row of applied) {
    const when = byHash.get(row.hash);
    const createdAt = Number(row.created_at);
    if (when === undefined || !(createdAt < when)) continue;
    await db.execute(sql`update ${table} set created_at = ${when} where id = ${row.id}`);
    reconciled.push({ hash: row.hash, createdAt, when });
  }
  return reconciled;
}

/** Reconcile, then run whatever the journal has that the database lacks. */
export async function applyMigrations(
  db: Database,
  kind: Connection['kind'],
  folder = migrationsFolder(),
  log: (message: string, detail: Record<string, unknown>) => void = () => undefined,
): Promise<void> {
  for (const r of await reconcileMigrationTimestamps(db, folder))
    log('db.migration_timestamp_reconciled', { ...r });
  if (kind === 'pglite') {
    await migratePglite(db as ReturnType<typeof drizzlePglite<typeof schema>>, {
      migrationsFolder: folder,
    });
  } else {
    await migratePostgres(db as ReturnType<typeof drizzlePostgres<typeof schema>>, {
      migrationsFolder: folder,
    });
  }
}

/**
 * `pglite://<dir>` (or `pglite://memory`) for development and tests, `postgres://…`
 * for production. Migrations run at connect so a fresh checkout works with no steps.
 */
export async function connect(
  url: string,
  opts: { log?: (message: string, detail: Record<string, unknown>) => void } = {},
): Promise<Connection> {
  const migrations = migrationsFolder();
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    if (target !== 'memory' && target !== '') mkdirSync(target, { recursive: true });
    const client = target === 'memory' || target === '' ? new PGlite() : new PGlite(target);
    const db = drizzlePglite(client, { schema });
    await applyMigrations(db, 'pglite', migrations, opts.log);
    return { db, kind: 'pglite', close: () => client.close() };
  }
  const sql = postgres(url, { max: 10, prepare: false });
  const db = drizzlePostgres(sql, { schema });
  await applyMigrations(db, 'postgres', migrations, opts.log);
  return { db, kind: 'postgres', close: () => sql.end({ timeout: 5 }) };
}
