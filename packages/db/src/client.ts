import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
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

/**
 * `pglite://<dir>` (or `pglite://memory`) for development and tests, `postgres://…`
 * for production. Migrations run at connect so a fresh checkout works with no steps.
 */
export async function connect(url: string): Promise<Connection> {
  const migrations = migrationsFolder();
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    if (target !== 'memory' && target !== '') mkdirSync(target, { recursive: true });
    const client = target === 'memory' || target === '' ? new PGlite() : new PGlite(target);
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder: migrations });
    return { db, kind: 'pglite', close: () => client.close() };
  }
  const sql = postgres(url, { max: 10, prepare: false });
  const db = drizzlePostgres(sql, { schema });
  await migratePostgres(db, { migrationsFolder: migrations });
  return { db, kind: 'postgres', close: () => sql.end({ timeout: 5 }) };
}
