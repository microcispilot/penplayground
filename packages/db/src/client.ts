import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

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
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    if (target !== 'memory' && target !== '') mkdirSync(target, { recursive: true });
    const client = target === 'memory' || target === '' ? new PGlite() : new PGlite(target);
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS });
    return { db, kind: 'pglite', close: () => client.close() };
  }
  const sql = postgres(url, { max: 10, prepare: false });
  const db = drizzlePostgres(sql, { schema });
  await migratePostgres(db, { migrationsFolder: MIGRATIONS });
  return { db, kind: 'postgres', close: () => sql.end({ timeout: 5 }) };
}
