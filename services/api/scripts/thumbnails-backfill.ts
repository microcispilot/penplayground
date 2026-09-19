import type { LessonPlan, SelectionBand, SessionMeta } from '@pen/contracts';
import {
  freshEstimateUsd,
  freshThumbnailUsd,
  LessonPlan as LessonPlanSchema,
} from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import type { LessonMemoEntry } from '@pen/session-engine';
import { planDigest, sessionMetaScope, thumbnailDigest } from '@pen/session-engine';
import { loadConfig } from '../src/config.js';
import { buildServices } from '../src/services.js';
import { createSessionMetaJobs, thumbnailPath } from '../src/thumbnails.js';

/**
 * Cards and thumbnails for sessions that have none — from before ADR-0013, or
 * whose background job failed — and, with `--redraw`, for the hand-drawn
 * sketches ADR-0021 replaced:
 *
 *   pnpm --filter @pen/api thumbnails:backfill                 every session without one
 *   pnpm --filter @pen/api thumbnails:backfill --limit 50      the 50 newest
 *   pnpm --filter @pen/api thumbnails:backfill --dry-run       what it would do, and what it would cost
 *   pnpm --filter @pen/api thumbnails:backfill --redraw        also replace pre-ADR-0021 sketches
 *   pnpm --filter @pen/api thumbnails:backfill --reencode      PNG cards → WebP + JPEG, no calls
 *
 * A backfill belongs to no learner, so it bills to `OPENAI_API_KEY_PLATFORM`
 * and never to a host's plan key — the opposite of a live session, whose card
 * and picture bill exactly where its lesson did. It uses the same queue the
 * rooms use, so it obeys the same concurrency cap and the same per-lesson
 * caches: a topic already written and already generated costs nothing here
 * either. Sessions whose files are on disk are repaired (record patched) with
 * no call at all, and a session still being taught is left to its own job.
 *
 * `--redraw` is the one that spends real money at scale: every session whose
 * scope has no cached picture is a fresh generation. `--dry-run` prices it
 * first, and the estimate is the number to look at before running it.
 *
 * `--reencode` is the opposite: it spends nothing at all. Sessions written
 * under ADR-0021 have a 434 kB PNG card and the generation that made it still
 * on disk as `source.png`, so ADR-0022's WebP card and JPEG Open Graph image
 * are re-derived from those bytes and the record is pointed at the new file.
 * No model is asked anything. It runs alone — combining it with a mode that
 * generates would blur a run that costs money into one that cannot.
 *
 * The lesson the card describes comes from the lesson memo when one exists for
 * the session's scope; otherwise the record's own title and promise stand in.
 */
interface Args {
  limit: number;
  dryRun: boolean;
  redraw: boolean;
  reencode: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 500, dryRun: false, redraw: false, reencode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--redraw') args.redraw = true;
    else if (a === '--reencode') args.reencode = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit needs a positive number');
      args.limit = Math.floor(n);
    } else if (a?.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit needs a positive number');
      args.limit = Math.floor(n);
    } else if (a === '-h' || a === '--help') {
      console.log('usage: thumbnails:backfill [--limit N] [--dry-run] [--redraw | --reencode]');
      process.exit(0);
    } else if (a !== undefined) throw new Error(`unknown argument: ${a}`);
  }
  if (args.redraw && args.reencode)
    throw new Error(
      '--redraw generates and --reencode never does; run them one at a time so a run that spends is never mistaken for one that does not.',
    );
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
  /**
   * The format pass. It asks no model anything, so it needs no key and runs
   * before the key check: every session it touches already has the generation
   * that paid for it, and only the derived files change.
   */
  if (args.reencode) {
    const candidates = await services.sessions.listWithPngThumbnail(args.limit);
    console.log(
      `${candidates.length} session${candidates.length === 1 ? '' : 's'} still on a PNG card ` +
        `(limit ${args.limit}) — re-derived from source.png, no API calls, $0.0000`,
    );
    let moved = 0;
    let after = 0;
    let withoutSource = 0;
    for (const record of candidates) {
      if (args.dryRun) {
        // `ready()` is the source's presence, which is the only thing that
        // decides between the two outcomes, so the dry run can report it.
        const can = services.thumbnails.ready(record.id);
        console.log(
          `  would ${can ? 're-encode' : 'skip     '} ${record.id}  ` +
            `${can ? '' : '(no source.png)  '}${record.title.slice(0, 56)}`,
        );
        continue;
      }
      const written = await services.thumbnails.reencode(record.id);
      if (!written) {
        withoutSource += 1;
        console.log(`  skip ${record.id}  no source.png to derive from`);
        continue;
      }
      await services.sessions.patch(record.id, { thumbnail: thumbnailPath(record.id) });
      moved += 1;
      after += written.cardBytes;
      console.log(
        `  re-encoded ${record.id}  card ${Math.round(written.cardBytes / 1024)} kB · ` +
          `og ${Math.round(written.ogBytes / 1024)} kB · ${Math.round(written.resizeMs)} ms`,
      );
    }
    if (!args.dryRun)
      console.log(
        `done: ${moved} re-encoded, ${withoutSource} without a source · ` +
          `cards now ${Math.round(after / 1024)} kB in total · spent $0.0000`,
      );
    process.exit(0);
  }

  // A backfill belongs to no learner, so it runs on the platform key and
  // never on a plan key. `PLATFORM` is passed as the job's host plan, so the
  // queue asks for that key for every call it makes here.
  if (!services.platformModel || !services.platformImage)
    throw new Error(
      'OPENAI_API_KEY_PLATFORM is not set. A backfill belongs to no learner and must not bill a plan key.',
    );
  const platformModel = services.platformModel;
  const platformImage = services.platformImage;
  const candidates = args.redraw
    ? [
        ...(await services.sessions.listWithoutThumbnail(args.limit)),
        ...(await services.sessions.listWithSketchThumbnail(args.limit)),
      ].slice(0, args.limit)
    : await services.sessions.listWithoutThumbnail(args.limit);
  const model = platformModel.id;
  console.log(
    `${candidates.length} session${candidates.length === 1 ? '' : 's'} ` +
      `${args.redraw ? 'without a picture or still showing a sketch' : 'without a picture'} ` +
      `(limit ${args.limit}, copy ${model}, picture ${platformImage.id} ${cfg.PEN_THUMBNAIL_QUALITY}, concurrency 2)`,
  );
  if (candidates.length === 0) process.exit(0);

  interface Job {
    record: SessionRecord;
    plan: LessonPlan;
    memo: boolean;
    /** Already on disk from an earlier run: patch the record, call nothing. */
    onDisk: boolean;
    /** The cache already holds this lesson's card copy: the text call costs nothing. */
    cached: boolean;
    /** The cache already holds this lesson's picture: the generation costs nothing. */
    pictureCached: boolean;
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
    const scope = record.canonicalId
      ? sessionMetaScope({
          canonicalId: record.canonicalId,
          band: record.band,
          expertId: record.expertId,
          language: record.language,
        })
      : null;
    const cached = scope
      ? (await services.metaCache.get({ scope, planDigest: planDigest(plan) })) !== null
      : false;
    const pictureCached = scope
      ? (await services.thumbnailCache.get({ scope, titleDigest: thumbnailDigest(plan) })) !== null
      : false;
    jobs.push({
      record,
      plan,
      memo: memo !== null,
      // A redraw is deliberate: the files on disk are the sketch we are replacing.
      onDisk: !args.redraw && services.thumbnails.ready(record.id),
      cached,
      pictureCached,
    });
  }

  const pending = jobs.filter((j) => !j.onDisk);
  // The picture is ~97 % of the bill, so it is priced separately: a run where
  // every copy is cached but no picture is still an expensive run.
  const copiesToWrite = pending.filter((j) => !j.cached).length;
  const picturesToDraw = pending.filter((j) => !j.pictureCached).length;
  const estimate =
    copiesToWrite * freshEstimateUsd('sessionMeta', model) +
    picturesToDraw * freshThumbnailUsd(platformImage.id, cfg.PEN_THUMBNAIL_QUALITY);
  console.log(
    `  ${jobs.filter((j) => j.onDisk).length} already rendered · ` +
      `${pending.length - picturesToDraw} pictures served by the cache · ` +
      `${picturesToDraw} pictures to generate · ${copiesToWrite} card copies to write · ` +
      `${jobs.filter((j) => j.memo).length} with a memo plan · ${skipped} skipped`,
  );
  console.log(`  estimated cost: ${usd(estimate)}`);

  if (args.dryRun) {
    for (const j of jobs)
      console.log(
        `  would ${j.onDisk ? 'repair  ' : j.pictureCached ? 'reuse   ' : 'generate'} ${j.record.id}  ` +
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
    // Every job here is the platform's, whatever plan the session's host is on.
    modelFor: () => platformModel,
    imageFor: () => platformImage,
    quality: () => services.config.get('PEN_THUMBNAIL_QUALITY'),
    store: services.thumbnails,
    sessions: services.sessions,
    cache: services.metaCache,
    imageCache: services.thumbnailCache,
    onUsage: (_input, usage) => {
      spent += usage.usd;
    },
    onDone: (input, result) => {
      done.add(input.sessionId);
      if (result.image?.reused ?? result.reused) reused += 1;
      else generated += 1;
      const bytes = result.image
        ? `${Math.round(result.image.png.length / 1024)} kB`
        : 'no picture';
      console.log(
        `  ${result.image?.reused ? 'reused  ' : 'drew    '} ${input.sessionId}  ` +
          `${usd(result.usage.usd + (result.image?.usage?.usd ?? 0))}  ` +
          `${Math.round(result.ms)} ms  ${bytes}`,
      );
    },
  });

  /**
   * Two jobs run at a time, so two sessions on the same lesson would both pay
   * for the same picture before either reached the cache. One session per
   * lesson goes first; everything else follows and is served from what that
   * one wrote.
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
        billTo: 'platform',
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
