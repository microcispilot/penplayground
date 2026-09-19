import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyOwner, SessionMeta } from '@pen/contracts';
import {
  SessionCategory,
  SessionMeta as SessionMetaSchema,
  THUMBNAIL_SIZE,
  ThumbnailQuality,
} from '@pen/contracts';
import type { SessionRepository } from '@pen/db';
import type { ImageModel, LanguageModel } from '@pen/llm';
import {
  type SessionMetaCachePort,
  type SessionMetaInput,
  SessionMetaJobs,
  type SessionMetaResult,
  type ThumbnailImageCachePort,
} from '@pen/session-engine';
import sharp from 'sharp';
import { z } from 'zod';
import { safeId } from './ledger.js';
import { observer } from './observability.js';

/**
 * Session thumbnails on disk (ADR-0013, amended by ADR-0021 and ADR-0022):
 * next to the ledger, under `<data>/sessions/<id>/`:
 *
 *   source.png  the generation as `gpt-image-1` returned it, 1536 × 1024
 *   thumb.webp  640 × 360 for the card
 *   og.jpg      1200 × 630 for Open Graph
 *   meta.json   the SessionMeta that produced them, with usage and timings
 *
 * **One generation, every size.** The API is billed per generation, not per
 * pixel, so a session calls it exactly once and both rendered files — and any
 * size we add later — are downscales of `source.png`. That is why the source
 * is kept as the model returned it, and why it stays PNG: it is the master the
 * others are re-derived from, never a file a browser is sent.
 *
 * **Raster, not vector.** A vector would scale to any size from one file,
 * which is the property we want, but the picture is a photograph and a
 * photograph has no vector form. `gpt-image-1` returns PNG bytes; tracing
 * them into paths would only give back a drawing, which is what this
 * replaced. Keeping the largest raster and downscaling gives the same
 * "generate once, use at every size" property without pretending.
 *
 * **Two formats, for two audiences** (ADR-0022). PNG is a lossless format for
 * flat colour, and a photograph is neither: across five real generations the
 * 640 × 360 card averaged 442 kB as PNG and 15 kB as WebP, so a row of twenty
 * went from ~8.6 MB to ~0.3 MB. The card is WebP, which every browser
 * that can run this app decodes. The Open Graph image is **JPEG**, not WebP,
 * on purpose: the only place Meta enumerates formats for `og:image` is the
 * `og:image:type` row of its Webmasters guide, and it lists `image/jpeg`,
 * `image/gif` and `image/png` — WebP is not documented as supported, and an
 * unfurl that silently shows nothing is not worth the kilobytes.
 * (developers.facebook.com/docs/sharing/webmasters/, read 2026-09-18.)
 *
 * Both derivations run through `sharp`, whose `toBuffer()` does the decode,
 * resize and encode on libuv's threadpool rather than the event loop. That
 * guard is not incidental: a load run at 50 concurrent sessions showed the
 * synchronous path stalling a trivial request by ~160 ms
 * (`services/api/scripts/load.ts`), which is a live room's audio fan-out.
 */

/**
 * The variants a request can ask for. `cardPng` and `ogPng` are what sessions
 * rendered before ADR-0022 have on disk; their records still point at
 * `thumb.png`, so the route keeps serving those files until a backfill
 * replaces them. Nothing writes one any more.
 */
export type ThumbnailKind = 'card' | 'og' | 'source' | 'svg' | 'cardPng' | 'ogPng';

export const THUMB_FILES: Record<ThumbnailKind | 'meta', string> = {
  source: 'source.png',
  card: 'thumb.webp',
  og: 'og.jpg',
  meta: 'meta.json',
  /**
   * Sessions drawn before ADR-0021 have a hand-drawn sketch here and their
   * record points at it. The renderer that made one is gone, so nothing
   * writes this any more — the route only serves the files that already
   * exist, so an old card keeps working until `thumbnails:backfill --redraw`
   * gives it a picture.
   */
  svg: 'thumb.svg',
  cardPng: 'thumb.png',
  ogPng: 'og.png',
};

/** The variants a session writes today; the rest are only ever read. */
export const DERIVED_KINDS = ['card', 'og'] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];

/** A variant that can be made again from `source.png` if it is missing. */
export function isDerived(kind: ThumbnailKind): kind is DerivedKind {
  return (DERIVED_KINDS as readonly ThumbnailKind[]).includes(kind);
}

export const THUMB_SIZES = {
  card: { width: 640, height: 360 },
  og: { width: 1200, height: 630 },
  source: THUMBNAIL_SIZE,
} as const;

export const THUMB_CONTENT_TYPE: Record<ThumbnailKind, string> = {
  card: 'image/webp',
  og: 'image/jpeg',
  source: 'image/png',
  svg: 'image/svg+xml',
  cardPng: 'image/png',
  ogPng: 'image/png',
};

/**
 * Encoder quality per derived size. It is the one knob either encoder has that
 * is a taste call dressed as a number, so it is named rather than inlined; the
 * bytes it buys are measured in ADR-0022. Everything else is the encoder's own
 * default, which is what a default is for.
 */
const ENCODE = {
  card: { quality: 82 },
  og: { quality: 82 },
} as const;

/** The public path a record stores once its thumbnail is ready. */
export function thumbnailPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/${THUMB_FILES.card}`;
}

/**
 * The byte counts `meta.json` records. Version 2 called all three of them
 * PNGs, because they were; the card is WebP and the Open Graph image is JPEG
 * from ADR-0022 on, so the names stop saying PNG and a v2 file is read through
 * the old ones. Nothing is rewritten on read: a card whose numbers are stale
 * is a card, and the backfill is where files get re-derived.
 */
const RenderBytes = z.preprocess(
  (raw) => {
    if (raw === null || typeof raw !== 'object') return raw;
    const r = raw as Record<string, unknown>;
    return {
      sourceBytes: r.sourceBytes ?? r.sourcePngBytes,
      cardBytes: r.cardBytes ?? r.cardPngBytes,
      ogBytes: r.ogBytes ?? r.ogPngBytes,
      resizeMs: r.resizeMs,
    };
  },
  z.object({
    sourceBytes: z.number().int(),
    cardBytes: z.number().int(),
    ogBytes: z.number().int(),
    /** Time spent deriving the two rendered files from the source, ms. */
    resizeMs: z.number(),
  }),
);

/** What `meta.json` holds; validated on read so a hand-edited file cannot break a request. */
export const StoredSessionMeta = z.object({
  /** 3 since ADR-0022 (thumb.webp + og.jpg); 2 is read, never written. */
  version: z.union([z.literal(2), z.literal(3)]),
  sessionId: z.string(),
  createdAt: z.number().int(),
  meta: SessionMetaSchema,
  usage: z.object({
    model: z.string(),
    inputTokens: z.number(),
    cachedTokens: z.number(),
    outputTokens: z.number(),
    usd: z.number(),
    totalMs: z.number(),
  }),
  attempts: z.number().int(),
  /** Copy served from the per-lesson cache instead of a model call. */
  reused: z.boolean().default(false),
  /** What writing this card and generating its picture fresh would have cost. */
  savedUsd: z.number().nonnegative().default(0),
  /** The generation behind the files; absent when both attempts failed. */
  image: z
    .object({
      model: z.string(),
      quality: ThumbnailQuality,
      /** Prompt tokens in, image tokens out; both 0 for a reuse. */
      inputTokens: z.number(),
      outputTokens: z.number(),
      usd: z.number(),
      ms: z.number(),
      attempts: z.number().int(),
      reused: z.boolean(),
    })
    .nullable()
    .default(null),
  render: RenderBytes,
});
export type StoredSessionMeta = z.infer<typeof StoredSessionMeta>;

export interface WrittenThumbnail {
  sourceBytes: number;
  cardBytes: number;
  ogBytes: number;
  resizeMs: number;
}

export class ThumbnailStore {
  constructor(private readonly sessionsDir: string) {}

  private dir(sessionId: string): string {
    return join(this.sessionsDir, safeId(sessionId));
  }

  /**
   * Write the generated picture and every size derived from it, plus
   * `meta.json`. The resizes — the expensive half — happen off the event
   * loop, so a burst of sessions ending never stalls the rooms that are
   * still speaking.
   */
  async write(
    sessionId: string,
    meta: SessionMeta,
    png: Buffer,
    provenance: {
      usage: StoredSessionMeta['usage'];
      attempts: number;
      reused?: boolean;
      savedUsd?: number;
      image?: StoredSessionMeta['image'];
    },
  ): Promise<WrittenThumbnail> {
    const dir = this.dir(sessionId);
    mkdirSync(dir, { recursive: true });
    const t0 = performance.now();
    const [card, og] = await Promise.all([derive(png, 'card'), derive(png, 'og')]);
    const resizeMs = performance.now() - t0;
    // The source first, the card last: the card's presence is what "ready"
    // means, so a crash mid-write never advertises a half set.
    writeAtomic(join(dir, THUMB_FILES.source), png);
    writeAtomic(join(dir, THUMB_FILES.og), og);
    writeAtomic(join(dir, THUMB_FILES.card), card);
    const written: WrittenThumbnail = {
      sourceBytes: png.length,
      cardBytes: card.length,
      ogBytes: og.length,
      resizeMs,
    };
    const stored: StoredSessionMeta = {
      version: 3,
      sessionId,
      createdAt: Date.now(),
      meta,
      usage: provenance.usage,
      attempts: provenance.attempts,
      reused: provenance.reused ?? false,
      savedUsd: provenance.savedUsd ?? 0,
      image: provenance.image ?? null,
      render: written,
    };
    writeFileSync(join(dir, THUMB_FILES.meta), JSON.stringify(stored));
    return written;
  }

  /**
   * Copy alone, for a session whose picture never arrived: the card keeps its
   * placeholder, but the description and keywords are still worth having.
   */
  writeCopyOnly(
    sessionId: string,
    meta: SessionMeta,
    provenance: {
      usage: StoredSessionMeta['usage'];
      attempts: number;
      reused?: boolean;
      savedUsd?: number;
    },
  ): void {
    const dir = this.dir(sessionId);
    mkdirSync(dir, { recursive: true });
    const stored: StoredSessionMeta = {
      version: 3,
      sessionId,
      createdAt: Date.now(),
      meta,
      usage: provenance.usage,
      attempts: provenance.attempts,
      reused: provenance.reused ?? false,
      savedUsd: provenance.savedUsd ?? 0,
      image: null,
      render: { sourceBytes: 0, cardBytes: 0, ogBytes: 0, resizeMs: 0 },
    };
    writeFileSync(join(dir, THUMB_FILES.meta), JSON.stringify(stored));
  }

  /**
   * Absolute path of an existing variant, or null. A rendered size that is
   * missing is derived from the source again — never generated again.
   */
  async file(sessionId: string, kind: ThumbnailKind): Promise<string | null> {
    const p = join(this.dir(sessionId), THUMB_FILES[kind]);
    if (existsSync(p)) return p;
    // Three kinds cannot be made: the source is the only thing that is not
    // derivable, a sketch from before ADR-0021 has no renderer left, and the
    // PNG pair from before ADR-0022 is deliberately never written again — the
    // route serves those two only for the records that still point at them.
    if (!isDerived(kind)) return null;
    const sourcePath = join(this.dir(sessionId), THUMB_FILES.source);
    if (!existsSync(sourcePath)) return null;
    // On the request path, so doubly worth keeping off the loop — and written
    // through a rename, because that is where concurrent readers are.
    writeAtomic(p, await derive(readFileSync(sourcePath), kind));
    observer.event('thumbnail.resize_on_demand', { kind });
    return p;
  }

  /**
   * Re-derive both rendered sizes from a source that is already on disk, in
   * today's formats. This is what moves a session written under ADR-0021 to a
   * WebP card, and it costs **nothing**: the generation is the whole bill and
   * it was paid once, for these exact bytes. Null when there is no source to
   * derive from — a pre-ADR-0021 sketch has none, and inventing one would mean
   * a new call.
   *
   * The PNG pair it supersedes is **kept**. `og.png` was the `og:image` on
   * every share page ever posted, and an unfurl cache re-fetches that URL
   * without re-scraping the page; deleting it would turn a picture that is
   * already in someone's Slack into a 404. They cost ~1.7 MB a session on a
   * disk the RUNBOOK budgets, and nothing links to them but the past.
   */
  async reencode(sessionId: string): Promise<WrittenThumbnail | null> {
    const dir = this.dir(sessionId);
    const sourcePath = join(dir, THUMB_FILES.source);
    if (!existsSync(sourcePath)) return null;
    const png = readFileSync(sourcePath);
    const t0 = performance.now();
    const [card, og] = await Promise.all([derive(png, 'card'), derive(png, 'og')]);
    const resizeMs = performance.now() - t0;
    writeAtomic(join(dir, THUMB_FILES.og), og);
    writeAtomic(join(dir, THUMB_FILES.card), card);
    const written: WrittenThumbnail = {
      sourceBytes: png.length,
      cardBytes: card.length,
      ogBytes: og.length,
      resizeMs,
    };
    // The card's provenance — what it cost, which model drew it — is unchanged
    // and must survive; only the byte counts and the version are now wrong.
    const stored = this.meta(sessionId);
    if (stored)
      writeAtomic(
        join(dir, THUMB_FILES.meta),
        Buffer.from(
          JSON.stringify({ ...stored, version: 3, render: written } satisfies StoredSessionMeta),
        ),
      );
    return written;
  }

  meta(sessionId: string): StoredSessionMeta | null {
    const p = join(this.dir(sessionId), THUMB_FILES.meta);
    if (!existsSync(p)) return null;
    const parsed = StoredSessionMeta.safeParse(JSON.parse(readFileSync(p, 'utf8')));
    return parsed.success ? parsed.data : null;
  }

  /** A card exists for this session (the source it was made from is what proves it). */
  ready(sessionId: string): boolean {
    return existsSync(join(this.dir(sessionId), THUMB_FILES.source));
  }

  /** ETag material for the route: mtime + size, so a re-render invalidates caches. */
  stat(path: string): { size: number; etag: string } {
    const st = statSync(path);
    return { size: st.size, etag: `"${Math.round(st.mtimeMs).toString(36)}-${st.size}"` };
  }
}

/**
 * Write-then-rename, the way the lesson-memo cache does it
 * (`meta-cache.ts`). Two things make it necessary here rather than merely
 * tidy: `file()` runs on the request path, so a reader can arrive between a
 * truncate and the bytes and stream a short body under a `Content-Length`
 * taken a moment earlier; and two crawlers hitting the same missing `og.jpg`
 * derive it concurrently. A rename is atomic, so either the old file or the
 * whole new one is there, never half of one.
 */
function writeAtomic(path: string, bytes: Buffer): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/**
 * One generated raster → one rendered size, in the format that size is served
 * in, on libuv's threadpool.
 *
 * `fit: 'cover'` with the default centre position is exactly the SVG
 * `preserveAspectRatio="xMidYMid slice"` this replaced: scale to fill, crop
 * what overflows, centred. The source is 3:2 and the card is 16:9, so a cover
 * keeps the subject and loses a little sky — which is what a thumbnail wants,
 * where a letterbox would give back bars.
 */
export async function derive(png: Buffer, kind: DerivedKind): Promise<Buffer> {
  const size = THUMB_SIZES[kind];
  const resized = sharp(png).resize(size.width, size.height, {
    fit: 'cover',
    position: 'centre',
  });
  return kind === 'card'
    ? resized.webp(ENCODE.card).toBuffer()
    : // Progressive + mozjpeg because an Open Graph image is fetched once by a
      // crawler and then shown at full width: bytes matter more than encode ms.
      resized.jpeg({ ...ENCODE.og, progressive: true, mozjpeg: true }).toBuffer();
}

/**
 * Wire the job queue to the store and the session index. Called once by
 * `buildServices`; rooms call `enqueue` right after their plan resolves.
 *
 * Both models are resolved per job from the HOST'S plan, so a free learner's
 * card copy and picture bill to the free key and a Professional host's to
 * theirs — the same key their lesson ran on.
 */
export function createSessionMetaJobs(deps: {
  modelFor: (owner: KeyOwner) => LanguageModel;
  imageFor: (owner: KeyOwner) => ImageModel;
  /** Picture quality, read per picture: it is a runtime setting (ADR-0025). */
  quality: () => ThumbnailQuality;
  store: ThumbnailStore;
  sessions: SessionRepository;
  /** Card copy already written for a lesson (ADR-0013); omitted, every session pays for its own. */
  cache?: SessionMetaCachePort;
  /** Pictures already generated for a lesson (ADR-0021); omitted, every session pays for its own. */
  imageCache?: ThumbnailImageCachePort;
  concurrency?: number;
  onUsage?: SessionMetaJobsHooks['onUsage'];
  /** Called after the record is patched; the backfill prints a line per session. */
  onDone?: (input: SessionMetaInput, result: SessionMetaResult) => void;
}): SessionMetaJobs {
  return new SessionMetaJobs({
    modelFor: deps.modelFor,
    imageFor: deps.imageFor,
    quality: deps.quality,
    observer,
    ...(deps.cache ? { cache: deps.cache } : {}),
    ...(deps.imageCache ? { imageCache: deps.imageCache } : {}),
    ...(deps.concurrency ? { concurrency: deps.concurrency } : {}),
    ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
    onResult: async (input, result: SessionMetaResult) => {
      const image = result.image;
      const provenance = {
        usage: result.usage,
        attempts: result.attempts,
        reused: result.reused,
        savedUsd: result.savedUsd,
        image: image
          ? {
              model: image.usage?.model ?? 'cache',
              quality: deps.quality(),
              inputTokens: image.usage?.inputTokens ?? 0,
              outputTokens: image.usage?.outputTokens ?? 0,
              usd: image.usage?.usd ?? 0,
              ms: image.ms,
              attempts: image.attempts,
              reused: image.reused,
            }
          : null,
      };
      let written: WrittenThumbnail | null = null;
      if (image)
        written = await deps.store.write(input.sessionId, result.meta, image.png, provenance);
      else deps.store.writeCopyOnly(input.sessionId, result.meta, provenance);
      const current = await deps.sessions.get(input.sessionId);
      // Onten's domain boundary is authoritative when it is one of ours; otherwise the model's category fills in.
      const domain =
        current && !SessionCategory.safeParse(current.domain).success
          ? result.meta.category
          : undefined;
      await deps.sessions.patch(input.sessionId, {
        // No picture, no thumbnail path: the card keeps its calm placeholder
        // rather than pointing at a file that is not there.
        ...(written ? { thumbnail: thumbnailPath(input.sessionId) } : {}),
        description: result.meta.description,
        keywords: result.meta.keywords,
        ...(domain ? { domain } : {}),
      });
      observer.event('thumbnail.ready', {
        sessionId: input.sessionId,
        billTo: input.billTo,
        sourceBytes: written?.sourceBytes ?? 0,
        cardBytes: written?.cardBytes ?? 0,
        ogBytes: written?.ogBytes ?? 0,
        resizeMs: Math.round(written?.resizeMs ?? 0),
        imageMs: Math.round(image?.ms ?? 0),
        usd: result.usage.usd + (image?.usage?.usd ?? 0),
        reused: result.reused,
        imageReused: image?.reused ?? false,
        savedUsd: result.savedUsd,
      });
      deps.onDone?.(input, result);
    },
  });
}

type SessionMetaJobsHooks = ConstructorParameters<typeof SessionMetaJobs>[0];
