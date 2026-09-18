import type { LessonPlan, SelectionBand, SessionMeta } from '@pen/contracts';
import { freshEstimateUsd, LessonPlan as LessonPlanSchema } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import type { LessonMemoEntry } from '@pen/session-engine';
import { planDigest, sessionMetaScope } from '@pen/session-engine';
import { loadConfig } from '../src/config.js';
import { buildServices } from '../src/services.js';
import { createSessionMetaJobs, thumbnailPath } from '../src/thumbnails.js';

/**
 * Cards and sketches for sessions that predate ADR-0013 (or whose background
 * job failed):
 *
 *   pnpm --filter @pen/api thumbnails:backfill                 every session without one
 *   pnpm --filter @pen/api thumbnails:backfill --limit 50      the 50 newest
 *   pnpm --filter @pen/api thumbnails:backfill --dry-run       what it would do, and what it would cost
 *
 * It uses the same queue the rooms use, so it obeys the same concurrency cap
 * (two model calls at a time) and the same per-lesson cache: a topic that was
 * already drawn costs nothing here either. Sessions whose files are already on
 * disk are repaired (record patched) without any model call, and a session
 * that is still being taught is left to its own job.
 *
 * The lesson the card describes comes from the lesson memo when one exists for
 * the session's scope; otherwise the record's own title and promise stand in.
 */
interface Args {
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 500, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit needs a positive number');
      args.limit = Math.floor(n);
    } else if (a?.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit needs a positive number');
      args.limit = Math.floor(n);
    } else if (a === '-h' || a === '--help') {
      console.log('usage: thumbnails:backfill [--limit N] [--dry-run]');
      process.exit(0);
    } else if (a !== undefined) throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** The memo holds the plan the lesson was actually taught from; it is what the card should describe. */
function planOf(record: SessionRecord, memo: LessonMemoEntry | null): LessonPlan {
  const fromMemo = memo ? LessonPlanSchema.safeParse(memo.plan) : null;
  if (fromMemo?.success) return fromMemo.data;
  const seconds = Math.max(60, Math.round((record.durationMs || 14 * 60_000) / 1000));
  const count = Math.max(1, record.segments);
  return {
    title: record.title || record.topic,
    promise: record.promise,
    band: record.band,
    seconds,
    segments: Array.from({ length: count }, (_, index) => ({
      index,
      title: index === 0 ? record.title || record.topic : `Part ${index + 1}`,
      goal: record.promise,
      seconds: Math.max(30, Math.round(seconds / count)),
      hasCheck: false,
    })),
  };
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const services = await buildServices(cfg);

try {
  const candidates = await services.sessions.listWithoutThumbnail(args.limit);
  const model = services.metaModel.id;
  console.log(
    `${candidates.length} session${candidates.length === 1 ? '' : 's'} without a sketch ` +
      `(limit ${args.limit}, model ${model}, concurrency 2)`,
  );
  if (candidates.length === 0) process.exit(0);

  interface Job {
    record: SessionRecord;
    plan: LessonPlan;
    memo: boolean;
    /** Already on disk from an earlier run: patch the record, call nothing. */
    onDisk: boolean;
    /** The cache already holds this lesson's card: it will cost nothing. */
    cached: boolean;
  }
  const jobs: Job[] = [];
  let skipped = 0;
  for (const record of candidates) {
    const expert = services.experts.get(record.expertId);
    if (!expert) {
      skipped += 1;
      console.log(`  skip ${record.id}  unknown expert ${record.expertId}`);
      continue;
    }
    // A session the API may still be teaching gets its own job; never race it.
    if (record.endedAt === null && Date.now() - record.startedAt < 3 * 60 * 60_000) {
      skipped += 1;
      console.log(`  skip ${record.id}  still live`);
      continue;
    }
    const memo = record.canonicalId
      ? await services.memo.find(record.canonicalId, record.band as SelectionBand, record.expertId)
      : null;
    const plan = planOf(record, memo);
    const cached = record.canonicalId
      ? (await services.metaCache.get({
          scope: sessionMetaScope({
            canonicalId: record.canonicalId,
            band: record.band,
            expertId: record.expertId,
            language: record.language,
          }),
          planDigest: planDigest(plan),
        })) !== null
      : false;
    jobs.push({
      record,
      plan,
      memo: memo !== null,
      onDisk: services.thumbnails.ready(record.id),
      cached,
    });
  }

  const toGenerate = jobs.filter((j) => !j.onDisk && !j.cached).length;
  const estimate = toGenerate * freshEstimateUsd('sessionMeta', model);
  console.log(
    `  ${jobs.filter((j) => j.onDisk).length} already rendered · ` +
      `${jobs.filter((j) => !j.onDisk && j.cached).length} served by the cache · ` +
      `${toGenerate} to generate · ${jobs.filter((j) => j.memo).length} with a memo plan · ` +
      `${skipped} skipped`,
  );
  console.log(`  estimated cost: ${usd(estimate)}`);

  if (args.dryRun) {
    for (const j of jobs)
      console.log(
        `  would ${j.onDisk ? 'repair  ' : j.cached ? 'reuse   ' : 'generate'} ${j.record.id}  ` +
          `${j.record.language}  ${j.plan.segments.length} seg  ${j.record.title.slice(0, 48)}`,
      );
    console.log('dry run: nothing was written.');
    process.exit(0);
  }

  let spent = 0;
  let generated = 0;
  let reused = 0;
  let repaired = 0;
  const done = new Set<string>();
  const jobsQueue = createSessionMetaJobs({
    model: services.metaModel,
    store: services.thumbnails,
    sessions: services.sessions,
    cache: services.metaCache,
    onUsage: (_input, usage) => {
      spent += usage.usd;
    },
    onDone: (input, result) => {
      done.add(input.sessionId);
      if (result.reused) reused += 1;
      else generated += 1;
      console.log(
        `  ${result.reused ? 'reused  ' : 'drew    '} ${input.sessionId}  ` +
          `${usd(result.usage.usd)}  ${Math.round(result.ms)} ms  ` +
          `${result.meta.thumbnail.elements.length} elements`,
      );
    },
  });

  /**
   * Two jobs run at a time, so two sessions on the same lesson would both draw
   * the same card before either reaches the cache. One session per lesson goes
   * first; everything else follows and is served from what that wrote.
   */
  const scopeOf = (job: Job) =>
    job.record.canonicalId
      ? sessionMetaScope({
          canonicalId: job.record.canonicalId,
          band: job.record.band,
          expertId: job.record.expertId,
          language: job.record.language,
        })
      : `session:${job.record.id}`;
  const seen = new Set<string>();
  const waves: Job[][] = [[], []];
  for (const job of jobs.filter((j) => !j.onDisk)) {
    const scope = scopeOf(job);
    (seen.has(scope) ? waves[1] : waves[0])?.push(job);
    seen.add(scope);
  }

  for (const job of jobs.filter((j) => j.onDisk)) {
    // The files exist; only the record is behind. No model call, no render.
    const stored = services.thumbnails.meta(job.record.id);
    const meta: SessionMeta | null = stored?.meta ?? null;
    await services.sessions.patch(job.record.id, {
      thumbnail: thumbnailPath(job.record.id),
      ...(meta ? { description: meta.description, keywords: meta.keywords } : {}),
    });
    repaired += 1;
    console.log(`  repaired ${job.record.id}  (files were already on disk)`);
  }

  for (const wave of waves) {
    for (const job of wave) {
      const expert = services.experts.get(job.record.expertId);
      if (!expert) continue;
      jobsQueue.enqueue({
        sessionId: job.record.id,
        expert,
        band: job.record.band as SelectionBand,
        topic: job.record.topic,
        plan: job.plan,
        language: job.record.language,
        ...(job.record.canonicalId ? { canonicalId: job.record.canonicalId } : {}),
        cacheKey: `pen:lesson:${expert.id}:${job.record.band}`,
      });
    }
    await jobsQueue.idle();
  }
  jobsQueue.close();

  const missing = jobs.filter((j) => !j.onDisk && !done.has(j.record.id)).length;
  console.log(
    `done: ${generated} drawn, ${reused} reused, ${repaired} repaired, ${missing} failed · spent ${usd(spent)}`,
  );
} finally {
  services.meta.close();
  services.exports.close();
  await services.db.close();
}
process.exit(0);
