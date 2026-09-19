import { join } from 'node:path';
import { STATS_SCHEMA_VERSION } from '@pen/contracts';
import { connect, ParticipantRepository, SessionRepository, StatsRepository } from '@pen/db';
import { loadConfig } from '../src/config.js';
import { FileLedger } from '../src/ledger.js';
import { StatsDeriver } from '../src/stats/deriver.js';

/**
 * Rebuild the statistics from the ledgers on disk (ADR-0027).
 *
 *   pnpm --filter @pen/api stats:backfill              every session whose row is missing or stale
 *   pnpm --filter @pen/api stats:backfill --all        every session on disk, whatever its row says
 *   pnpm --filter @pen/api stats:backfill --limit 500  stop after this many derivations
 *   pnpm --filter @pen/api stats:backfill --dry-run    say what would change and write nothing
 *
 * Safe to run at any time, including against production while it is serving:
 * every write is an upsert keyed by session id, and the ledger it reads is
 * append-only. Sessions are walked **oldest first**, which is what makes the
 * reuse origins come out right — the session that actually generated a piece
 * of work is the first one to claim it.
 *
 * "Stale" means the ledger has grown since the row was written (a thumbnail
 * that landed after the room closed), or the row was written by an older
 * `STATS_SCHEMA_VERSION`. That is why a change to the derivation is a re-run
 * of this and never a migration.
 */

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const numberFlag = (flag: string): number | null => {
  const i = args.indexOf(flag);
  const raw = i >= 0 ? args[i + 1] : undefined;
  const v = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
};

const all = has('--all');
const dryRun = has('--dry-run');
const limit = numberFlag('--limit') ?? Number.POSITIVE_INFINITY;

const cfg = loadConfig();
const ledger = new FileLedger(join(cfg.PEN_DATA_DIR, 'sessions'));
const db = await connect(cfg.DATABASE_URL);
const sessions = new SessionRepository(db.db);
const participants = new ParticipantRepository(db.db);
const stats = new StatsRepository(db.db);

const onDisk = ledger.list();
console.log(`${onDisk.length} session ledgers under ${join(cfg.PEN_DATA_DIR, 'sessions')}`);

// Oldest first: the origin of a reused lesson is claimed by whoever taught it
// first, and that is only true if they are derived first.
const records = (await Promise.all(onDisk.map((id) => sessions.get(id))))
  .filter((r): r is NonNullable<typeof r> => r !== null)
  .sort((a, b) => a.startedAt - b.startedAt);
const orphans = onDisk.length - records.length;
if (orphans > 0) console.log(`${orphans} ledgers have no session row and are skipped`);

const derived = await stats.derivedState(records.map((r) => r.id));
const todo = all
  ? records
  : records.filter((r) => {
      const state = derived.get(r.id);
      if (!state) return true;
      if (state.schemaVersion !== STATS_SCHEMA_VERSION) return true;
      return state.ledgerEntries !== ledger.read(r.id).length;
    });
console.log(
  `${todo.length} to derive (${records.length - todo.length} already current at schema v${STATS_SCHEMA_VERSION})`,
);

if (dryRun) {
  for (const r of todo.slice(0, 20)) console.log(`  would derive ${r.id}  ${r.topic.slice(0, 60)}`);
  if (todo.length > 20) console.log(`  … and ${todo.length - 20} more`);
  await db.close();
  process.exit(0);
}

const deriver = new StatsDeriver({
  ledger,
  sessions,
  participants,
  stats,
  onError: (area, error, detail) =>
    console.error(`  ! ${area}`, detail ?? {}, error instanceof Error ? error.message : error),
});

const counts: Record<string, number> = {};
const startedAt = Date.now();
let done = 0;
for (const record of todo) {
  if (done >= limit) break;
  try {
    const outcome = await deriver.derive(record.id, { endReason: 'unknown' });
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  } catch (error) {
    counts.failed = (counts.failed ?? 0) + 1;
    console.error(`  ! ${record.id}`, error instanceof Error ? error.message : error);
  }
  done += 1;
  if (done % 100 === 0) console.log(`  ${done}/${Math.min(todo.length, limit)}…`);
}
deriver.close();

const ms = Date.now() - startedAt;
console.log(
  `\nderived ${done} session(s) in ${(ms / 1000).toFixed(1)} s`,
  Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' '),
);
await db.close();
