import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SelectionBand } from '@pen/contracts';
import {
  connect,
  type DuplicateGroup,
  type DuplicateMember,
  ListRepository,
  rankTellings,
  SessionRepository,
  StatsRepository,
} from '@pen/db';
import { createOnten } from '@pen/onten';
import { loadConfig } from '../src/config.js';
import { FileLedger } from '../src/ledger.js';

/**
 * One lesson, one card: collapse the sessions that are the same lesson told
 * twice, and leave a signpost where each one stood (ADR-0031).
 *
 *   pnpm --filter @pen/api sessions:dedupe                    say what it would do; write nothing
 *   pnpm --filter @pen/api sessions:dedupe --apply            do it
 *   pnpm --filter @pen/api sessions:dedupe --include-accounts also collapse a signed-in host's tellings
 *   pnpm --filter @pen/api sessions:dedupe --no-repair        skip the canonical-id repair pass
 *   pnpm --filter @pen/api sessions:dedupe --limit 50         stop after this many erasures
 *
 * **The dry run is the default.** Every other script here defaults to doing
 * the work and takes `--dry-run`; this one deletes recordings, so the flag is
 * the other way round on purpose. `--dry-run` is accepted and means what it
 * says. Nothing here ever runs at boot.
 *
 * ## What counts as a duplicate
 *
 * The **lesson scope** — `canonicalId|band|expertId|language` — is the key the
 * lesson memo, the card copy and the generated picture are all stored under
 * (`scopeKeyFor` in `src/stats/derive.ts`). Two public, ended sessions sharing
 * it were taught from the *same* memo: the same plan, the same cue script, the
 * same photograph. They are one lesson told twice, and the catalogue showing
 * both is the bug the owner saw.
 *
 * Deliberately *not* duplicates: a private session (in nobody's catalogue), a
 * live one (still being taught), a session with no canonical topic (nothing
 * says it is the same lesson as anything), and the same topic at another band,
 * in another language or from another expert — a different lesson, generated
 * separately and priced separately.
 *
 * ## What is kept
 *
 * `rankTellings` in `@pen/db` is the rule, and the catalogue's own SQL spells
 * the same one: how far the telling got (recap points, then how long it ran),
 * then how engaged anyone was (views + likes + saves), then the oldest, whose
 * link is the one most likely already shared. Not `sessions.segments` — that
 * is the *plan's* length and is identical for every telling of one memoised
 * lesson, so it separates nothing.
 *
 * This script adds one criterion the database cannot see: a telling whose
 * recording is still on disk outranks one whose directory has gone, because
 * keeping an unreplayable row as the lesson's only card would be the worst
 * outcome here.
 *
 * ## Nothing is silently destroyed
 *
 * For each telling that goes: its saves, likes and history move onto the one
 * that was kept, so nobody loses a lesson off a shelf; its views are added to
 * the survivor's, because the card now stands for the lesson; every site visit
 * that ended on it is repointed; its derived statistics go, because they were
 * rolled out of a ledger that is going too; its directory (ledger, audio,
 * thumbnails, any rendered video) is erased; and a redirect row is written so
 * `/s/<old id>` and `/api/sessions/<old id>` answer with the lesson that was
 * kept rather than a 404.
 *
 * ## The repair pass
 *
 * A session written before `canonical_id` existed, or whose row never got it,
 * has no scope and cannot be grouped — which is most of the duplicates on an
 * old database. Before scanning, this fills the column in from evidence, never
 * from a guess: first the `resolve` metric in the session's own ledger, which
 * is what it actually resolved to; failing that, the registry's answer for the
 * session's stored topic, which is exactly what `rooms.create` would have
 * written. The dry run reports both without writing either, and the scan it
 * prints is the scan those repairs would produce.
 */

interface Args {
  apply: boolean;
  includeAccounts: boolean;
  repair: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    includeAccounts: false,
    repair: true,
    limit: Number.POSITIVE_INFINITY,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--include-accounts') args.includeAccounts = true;
    else if (a === '--no-repair') args.repair = false;
    else if (a === '--limit' || a?.startsWith('--limit=')) {
      const raw = a === '--limit' ? argv[++i] : a.slice('--limit='.length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit needs a positive number');
      args.limit = Math.floor(n);
    } else if (a === '-h' || a === '--help') {
      console.log(
        'usage: sessions:dedupe [--apply] [--include-accounts] [--no-repair] [--limit N]',
      );
      process.exit(0);
    } else if (a !== undefined) throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** `fa-IR` and `fa` are one language to the registry; the packs are keyed by the subtag. */
const subtag = (language: string) => (language.split('-')[0] ?? language).toLowerCase();

const label = (m: DuplicateMember, hasRecording: boolean) =>
  `${m.id}  recap=${m.recapPoints} ran=${(m.durationMs / 1000).toFixed(1)}s views=${m.views} likes=${m.likes} saves=${m.saves} ${new Date(m.startedAt).toISOString().slice(0, 16)}${hasRecording ? '' : ' [no recording]'}${m.hostIsAccount ? ' [account]' : ''}`;

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const sessionsDir = join(cfg.PEN_DATA_DIR, 'sessions');
const ledger = new FileLedger(sessionsDir);
const onten = createOnten({ dataDir: join(cfg.PEN_DATA_DIR, 'onten') });
const conn = await connect(cfg.DATABASE_URL);
const sessions = new SessionRepository(conn.db);
const lists = new ListRepository(conn.db);
const stats = new StatsRepository(conn.db);

console.log(
  `${args.apply ? 'APPLY' : 'DRY RUN'} — ${cfg.DATABASE_URL}, artefacts under ${sessionsDir}`,
);
if (!args.apply) console.log('nothing will be written; add --apply to do it\n');
else console.log('');

// ── phase 1: give every session a scope, from evidence ───────────────────────
/** `sessionId → canonicalId`, with where it came from, for rows that have none. */
const repaired = new Map<string, string>();
const repairEvidence = new Map<string, string>();
if (args.repair) {
  const orphans = (await sessions.listWithoutCanonicalId()).filter(
    (r) => r.visibility === 'public' && r.endedAt !== null,
  );
  for (const record of orphans) {
    // What the session itself recorded resolving to, if its ledger is old
    // enough to say. This is observation, not inference.
    let canonical: string | null = null;
    let evidence = '';
    for (const entry of ledger.read(record.id)) {
      if (entry.kind !== 'metric' || entry.sample.stage !== 'resolve') continue;
      const id = entry.sample.meta.canonicalId;
      if (typeof id === 'string' && id.length > 0) {
        canonical = id;
        evidence = 'ledger';
      }
    }
    if (!canonical) {
      // Nothing recorded: ask the registry the same question `rooms.create`
      // asks, with the session's own topic. The canonical id is the
      // registry's to decide and never ours to mint (docs/ONTEN-BOUNDARY.md).
      const resolution = await onten.registry.resolveTopic({
        text: record.topic,
        language: subtag(record.language),
        locale: record.language,
        band: record.band as SelectionBand,
      });
      canonical = resolution.canonicalKnowledgeId;
      evidence = `registry(${resolution.match})`;
    }
    repaired.set(record.id, canonical);
    repairEvidence.set(record.id, evidence);
  }
  console.log(`repair: ${repaired.size} session(s) have no canonical topic on the row`);
  for (const [id, canonical] of repaired)
    console.log(
      `  ${args.apply ? 'set' : 'would set'} ${id} → ${canonical}  (${repairEvidence.get(id)})`,
    );
  if (args.apply)
    for (const [id, canonicalId] of repaired) await sessions.patch(id, { canonicalId });
  console.log('');
}

// ── phase 2: what is duplicated ──────────────────────────────────────────────
const groups: DuplicateGroup[] = await sessions.duplicateGroups(
  args.apply ? {} : { assumeCanonical: repaired },
);

/**
 * One criterion the database cannot see: whether the recording is still on
 * disk. A session row whose directory is gone — an older record, a ledger
 * cleared by hand — replays as an empty board, and keeping *that* as the
 * lesson's one card while erasing the tellings that still have their audio
 * would be the worst outcome this script could reach. So a telling that can
 * still be replayed outranks one that cannot, and the rule the database
 * spells decides among equals. After a collapse each scope has one member,
 * so the catalogue and this agree again by construction.
 */
const recorded = (id: string) => existsSync(join(sessionsDir, id));

let held = 0;
let unrecordedKept = 0;
const actionable = groups
  .map((g) => {
    const ranked = rankTellings([g.keep, ...g.drop]);
    const [keep, ...rest] = [
      ...ranked.filter((m) => recorded(m.id)),
      ...ranked.filter((m) => !recorded(m.id)),
    ];
    if (!keep) return { ...g, drop: [] as DuplicateMember[] };
    if (!recorded(keep.id)) unrecordedKept += 1;
    return {
      ...g,
      keep,
      drop: rest.filter((m) => {
        if (args.includeAccounts || !m.hostIsAccount) return true;
        held += 1;
        return false;
      }),
    };
  })
  .filter((g) => g.drop.length > 0);

const total = actionable.reduce((n, g) => n + g.drop.length, 0);
console.log(
  `${groups.length} lesson(s) taught more than once; ${actionable.length} to collapse, ${total} telling(s) to erase`,
);
if (unrecordedKept > 0)
  console.log(
    `${unrecordedKept} lesson(s) have no telling left with a recording on disk; the best row is kept as the card anyway`,
  );
if (held > 0)
  console.log(
    `${held} telling(s) held back because a signed-in account hosts them — their history is theirs; --include-accounts collapses those too`,
  );
console.log('');

for (const group of actionable) {
  console.log(group.scopeKey);
  console.log(`  keep  ${label(group.keep, recorded(group.keep.id))}`);
  for (const m of group.drop) console.log(`  erase ${label(m, recorded(m.id))}`);
}
if (actionable.length > 0) console.log('');

// What the disk gets back, measured rather than estimated.
const bytesOf = (dir: string): number => {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    n += entry.isDirectory() ? bytesOf(p) : statSync(p).size;
  }
  return n;
};
const freed = actionable
  .flatMap((g) => g.drop)
  .reduce((n, m) => n + bytesOf(join(sessionsDir, m.id)), 0);
console.log(`${(freed / 1024 / 1024).toFixed(1)} MB of recordings would be freed`);

if (!args.apply) {
  console.log('\ndry run — nothing was written. Re-run with --apply.');
  await conn.close();
  process.exit(0);
}

// ── phase 3: collapse ────────────────────────────────────────────────────────
let done = 0;
const counts = { moved: 0, visits: 0, erased: 0, failed: 0 };
for (const group of actionable) {
  for (const member of group.drop) {
    if (done >= args.limit) break;
    try {
      // Order matters: everything that must survive moves before anything is
      // erased, so a crash half way leaves rows pointing at a session that is
      // still there rather than at one that is gone.
      const moved = await lists.moveSession(member.id, group.keep.id);
      counts.moved += moved.saved + moved.liked + moved.history;
      counts.visits += await stats.moveSession(member.id, group.keep.id);
      if (member.views > 0) {
        const survivor = await sessions.get(group.keep.id);
        if (survivor) await sessions.patch(group.keep.id, { views: survivor.views + member.views });
      }
      await sessions.redirect(member.id, group.keep.id, 'duplicate');
      await stats.removeSession(member.id);
      await lists.forgetSession(member.id);
      ledger.remove(member.id);
      await sessions.remove(member.id);
      counts.erased += 1;
      console.log(`  erased ${member.id} → ${group.keep.id}`);
    } catch (error) {
      counts.failed += 1;
      console.error(`  ! ${member.id}`, error instanceof Error ? error.message : error);
    }
    done += 1;
  }
}

const survivors = await sessions.listPublic();
console.log(
  `\nerased ${counts.erased}, failed ${counts.failed}; ${counts.moved} shelf row(s) and ${counts.visits} visit(s) moved to the telling that was kept`,
);
console.log(`the catalogue now shows ${survivors.length} card(s)`);
await conn.close();
