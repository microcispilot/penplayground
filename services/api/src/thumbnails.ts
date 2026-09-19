import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { renderAsync } from '@resvg/resvg-js';
import { z } from 'zod';
import { safeId } from './ledger.js';
import { observer } from './observability.js';

/**
 * Session thumbnails on disk (ADR-0013, amended by ADR-0021): next to the
 * ledger, under `<data>/sessions/<id>/`:
 *
 *   source.png  the generation as `gpt-image-1` returned it, 1536 × 1024
 *   thumb.png   640 × 360 for the card
 *   og.png      1200 × 630 for Open Graph
 *   meta.json   the SessionMeta that produced them, with usage and timings
 *
 * **One generation, every size.** The API is billed per generation, not per
 * pixel, so a session calls it exactly once and both rendered files — and any
 * size we add later — are downscales of `source.png`. That is why the source
 * is kept: a new size must never mean a new call.
 *
 * **Raster, not vector.** A vector would scale to any size from one file,
 * which is the property we want, but the picture is a photograph and a
 * photograph has no vector form. `gpt-image-1` returns PNG bytes; tracing
 * them into paths would only give back a drawing, which is what this
 * replaced. Keeping the largest raster and downscaling gives the same
 * "generate once, use at every size" property without pretending.
 *
 * Downscaling goes through resvg's **async** entry point on purpose. The
 * synchronous one runs the whole render on the event loop, and a session's
 * two PNGs are ~250 ms of it — long enough to stall every live room's audio
 * fan-out at once, which a load run at 50 concurrent sessions showed as
 * ~160 ms stalls on a trivial request (`services/api/scripts/load.ts`).
 * `renderAsync` runs on libuv's threadpool, so the loop keeps turning and the
 * PCM keeps flowing while the picture is resized.
 */

export type ThumbnailKind = 'card' | 'og' | 'source' | 'svg';

export const THUMB_FILES: Record<ThumbnailKind | 'meta', string> = {
  source: 'source.png',
  card: 'thumb.png',
  og: 'og.png',
  meta: 'meta.json',
  /**
   * Sessions drawn before ADR-0021 have a hand-drawn sketch here and their
   * record points at it. The renderer that made one is gone, so nothing
   * writes this any more — the route only serves the files that already
   * exist, so an old card keeps working until `thumbnails:backfill --redraw`
   * gives it a picture.
   */
  svg: 'thumb.svg',
};

export const THUMB_SIZES = {
  card: { width: 640, height: 360 },
  og: { width: 1200, height: 630 },
  source: THUMBNAIL_SIZE,
} as const;

export const THUMB_CONTENT_TYPE: Record<ThumbnailKind, string> = {
  card: 'image/png',
  og: 'image/png',
  source: 'image/png',
  svg: 'image/svg+xml',
};

/** The public path a record stores once its thumbnail is ready. */
export function thumbnailPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/${THUMB_FILES.card}`;
}

/** What `meta.json` holds; validated on read so a hand-edited file cannot break a request. */
export const StoredSessionMeta = z.object({
  version: z.literal(2),
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
  render: z.object({
    sourcePngBytes: z.number().int(),
    cardPngBytes: z.number().int(),
    ogPngBytes: z.number().int(),
    /** Time spent downscaling the source into the two rendered files, ms. */
    resizeMs: z.number(),
  }),
});
export type StoredSessionMeta = z.infer<typeof StoredSessionMeta>;

export interface WrittenThumbnail {
  sourcePngBytes: number;
  cardPngBytes: number;
  ogPngBytes: number;
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
    const [cardPng, ogPng] = await Promise.all([
      downscale(png, THUMB_SIZES.card),
      downscale(png, THUMB_SIZES.og),
    ]);
    const resizeMs = performance.now() - t0;
    // The source first, the card last: the card's presence is what "ready"
    // means, so a crash mid-write never advertises a half set.
    writeFileSync(join(dir, THUMB_FILES.source), png);
    writeFileSync(join(dir, THUMB_FILES.og), ogPng);
    writeFileSync(join(dir, THUMB_FILES.card), cardPng);
    const written: WrittenThumbnail = {
      sourcePngBytes: png.length,
      cardPngBytes: cardPng.length,
      ogPngBytes: ogPng.length,
      resizeMs,
    };
    const stored: StoredSessionMeta = {
      version: 2,
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
      version: 2,
      sessionId,
      createdAt: Date.now(),
      meta,
      usage: provenance.usage,
      attempts: provenance.attempts,
      reused: provenance.reused ?? false,
      savedUsd: provenance.savedUsd ?? 0,
      image: null,
      render: { sourcePngBytes: 0, cardPngBytes: 0, ogPngBytes: 0, resizeMs: 0 },
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
    // The source is the only thing that cannot be re-derived, and a sketch
    // from before ADR-0021 has no renderer left; both are simply absent.
    if (kind === 'source' || kind === 'svg') return null;
    const sourcePath = join(this.dir(sessionId), THUMB_FILES.source);
    if (!existsSync(sourcePath)) return null;
    // On the request path, so doubly worth keeping off the loop.
    writeFileSync(p, await downscale(readFileSync(sourcePath), THUMB_SIZES[kind]));
    observer.event('thumbnail.resize_on_demand', { kind });
    return p;
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
 * One generated raster → one rendered size, on libuv's threadpool.
 *
 * resvg is an SVG rasteriser, so the picture is wrapped in a one-element SVG
 * of the target size and drawn with `preserveAspectRatio="xMidYMid slice"`:
 * scale to fill, crop what overflows, centred. The source is 3:2 and the card
 * is 16:9, so a slice keeps the subject and loses a little sky — which is
 * what a thumbnail wants, where a letterbox would give back bars.
 */
export async function downscale(
  png: Buffer,
  size: { width: number; height: number },
): Promise<Buffer> {
  const href = `data:image/png;base64,${png.toString('base64')}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">` +
    `<image x="0" y="0" width="${size.width}" height="${size.height}" ` +
    `preserveAspectRatio="xMidYMid slice" href="${href}"/></svg>`;
  const rendered = await renderAsync(svg, { fitTo: { mode: 'width', value: size.width } });
  return rendered.asPng();
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
  quality: ThumbnailQuality;
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
              quality: deps.quality,
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
        sourcePngBytes: written?.sourcePngBytes ?? 0,
        cardPngBytes: written?.cardPngBytes ?? 0,
        ogPngBytes: written?.ogPngBytes ?? 0,
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
