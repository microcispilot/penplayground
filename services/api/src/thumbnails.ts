import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  createThumbnailFont,
  parseHandFont,
  type RenderedThumbnail,
  renderSketchSvg,
  type ThumbnailFont,
} from '@pen/board/thumbnail';
import type { SessionMeta } from '@pen/contracts';
import { SessionCategory, SessionMeta as SessionMetaSchema } from '@pen/contracts';
import type { SessionRepository } from '@pen/db';
import type { LanguageModel } from '@pen/llm';
import {
  type SessionMetaInput,
  SessionMetaJobs,
  type SessionMetaResult,
} from '@pen/session-engine';
import { Resvg } from '@resvg/resvg-js';
import { z } from 'zod';
import { safeId } from './ledger.js';
import { observer } from './observability.js';

/**
 * Session thumbnails on disk (ADR-0013): next to the ledger, under
 * `<data>/sessions/<id>/`:
 *
 *   thumb.svg   the sketch, self-contained (cards, the session page)
 *   thumb.png   640 × 360 raster for clients that want a bitmap
 *   og.png      1200 × 630 raster for Open Graph (most scrapers ignore SVG)
 *   meta.json   the SessionMeta that produced them, with usage and timings
 *
 * The PNGs are rasterised with resvg in-process (≈ 50 ms each); a session
 * that only has the SVG (older data) gets its PNG on first request.
 */

export type ThumbnailKind = 'svg' | 'card' | 'og';

export const THUMB_FILES: Record<ThumbnailKind | 'meta', string> = {
  svg: 'thumb.svg',
  card: 'thumb.png',
  og: 'og.png',
  meta: 'meta.json',
};

export const THUMB_SIZES = {
  card: { width: 640, height: 360 },
  og: { width: 1200, height: 630 },
} as const;

export const THUMB_CONTENT_TYPE: Record<ThumbnailKind, string> = {
  svg: 'image/svg+xml',
  card: 'image/png',
  og: 'image/png',
};

/** The public path a record stores once its thumbnail is ready. */
export function thumbnailPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/${THUMB_FILES.svg}`;
}

/** What `meta.json` holds; validated on read so a hand-edited file cannot break a request. */
export const StoredSessionMeta = z.object({
  version: z.literal(1),
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
  render: z.object({
    svgBytes: z.number().int(),
    svgMs: z.number(),
    cardPngBytes: z.number().int(),
    ogPngBytes: z.number().int(),
    rasterMs: z.number(),
    unsupportedChars: z.array(z.string()),
  }),
});
export type StoredSessionMeta = z.infer<typeof StoredSessionMeta>;

const require = createRequire(import.meta.url);

/**
 * Caveat subsets for the pen: latin, latin-ext and cyrillic cover the
 * languages we teach in with a hand font; anything else is squiggled by the
 * renderer. Loaded once per process (~5 ms).
 */
export function loadThumbnailFont(): ThumbnailFont {
  const subsets = ['latin', 'latin-ext', 'cyrillic'];
  return createThumbnailFont(
    subsets.map((s) =>
      parseHandFont(
        readFileSync(require.resolve(`@fontsource/caveat/files/caveat-${s}-400-normal.woff`)),
      ),
    ),
  );
}

export interface WrittenThumbnail {
  svgBytes: number;
  svgMs: number;
  cardPngBytes: number;
  ogPngBytes: number;
  rasterMs: number;
  unsupportedChars: string[];
}

export class ThumbnailStore {
  constructor(
    private readonly sessionsDir: string,
    private readonly font: ThumbnailFont,
  ) {}

  private dir(sessionId: string): string {
    return join(this.sessionsDir, safeId(sessionId));
  }

  /** Render the sketch and write every variant plus `meta.json`. Synchronous: ≈ 120 ms in total. */
  write(
    sessionId: string,
    meta: SessionMeta,
    provenance: { usage: StoredSessionMeta['usage']; attempts: number },
  ): WrittenThumbnail {
    const dir = this.dir(sessionId);
    mkdirSync(dir, { recursive: true });
    const t0 = performance.now();
    const card: RenderedThumbnail = renderSketchSvg(meta.thumbnail, this.font, { seed: sessionId });
    const og = renderSketchSvg(meta.thumbnail, this.font, { seed: sessionId, ...THUMB_SIZES.og });
    const t1 = performance.now();
    const cardPng = rasterise(card.svg, THUMB_SIZES.card.width);
    const ogPng = rasterise(og.svg, THUMB_SIZES.og.width);
    const t2 = performance.now();
    // The SVG last: its presence is what "ready" means, so a crash mid-write never advertises a half set.
    writeFileSync(join(dir, THUMB_FILES.card), cardPng);
    writeFileSync(join(dir, THUMB_FILES.og), ogPng);
    writeFileSync(join(dir, THUMB_FILES.svg), card.svg);
    const written: WrittenThumbnail = {
      svgBytes: card.bytes,
      svgMs: t1 - t0,
      cardPngBytes: cardPng.length,
      ogPngBytes: ogPng.length,
      rasterMs: t2 - t1,
      unsupportedChars: card.unsupportedChars,
    };
    const stored: StoredSessionMeta = {
      version: 1,
      sessionId,
      createdAt: Date.now(),
      meta,
      usage: provenance.usage,
      attempts: provenance.attempts,
      render: written,
    };
    writeFileSync(join(dir, THUMB_FILES.meta), JSON.stringify(stored));
    return written;
  }

  /** Absolute path of an existing variant, or null. PNGs are made on demand from an existing SVG. */
  file(sessionId: string, kind: ThumbnailKind): string | null {
    const p = join(this.dir(sessionId), THUMB_FILES[kind]);
    if (existsSync(p)) return p;
    if (kind === 'svg') return null;
    const svgPath = join(this.dir(sessionId), THUMB_FILES.svg);
    if (!existsSync(svgPath)) return null;
    const stored = this.meta(sessionId);
    if (!stored) return null;
    const size = THUMB_SIZES[kind];
    const svg = renderSketchSvg(stored.meta.thumbnail, this.font, { seed: sessionId, ...size });
    writeFileSync(p, rasterise(svg.svg, size.width));
    observer.event('thumbnail.raster_on_demand', { kind });
    return p;
  }

  meta(sessionId: string): StoredSessionMeta | null {
    const p = join(this.dir(sessionId), THUMB_FILES.meta);
    if (!existsSync(p)) return null;
    const parsed = StoredSessionMeta.safeParse(JSON.parse(readFileSync(p, 'utf8')));
    return parsed.success ? parsed.data : null;
  }

  ready(sessionId: string): boolean {
    return existsSync(join(this.dir(sessionId), THUMB_FILES.svg));
  }

  /** ETag material for the route: mtime + size, so a re-render invalidates caches. */
  stat(path: string): { size: number; etag: string } {
    const st = statSync(path);
    return { size: st.size, etag: `"${Math.round(st.mtimeMs).toString(36)}-${st.size}"` };
  }
}

function rasterise(svg: string, width: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}

/**
 * Wire the job queue to the store and the session index. Called once by
 * `buildServices`; rooms call `enqueue` right after their plan resolves.
 */
export function createSessionMetaJobs(deps: {
  model: LanguageModel;
  store: ThumbnailStore;
  sessions: SessionRepository;
  onUsage?: (
    input: SessionMetaInput,
    usage: Parameters<NonNullable<SessionMetaJobsHooks['onUsage']>>[1],
  ) => void;
}): SessionMetaJobs {
  return new SessionMetaJobs({
    model: deps.model,
    observer,
    ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
    onResult: async (input, result: SessionMetaResult) => {
      const written = deps.store.write(input.sessionId, result.meta, {
        usage: result.usage,
        attempts: result.attempts,
      });
      const current = await deps.sessions.get(input.sessionId);
      // Onten's domain boundary is authoritative when it is one of ours; otherwise the model's category fills in.
      const domain =
        current && !SessionCategory.safeParse(current.domain).success
          ? result.meta.category
          : undefined;
      await deps.sessions.patch(input.sessionId, {
        thumbnail: thumbnailPath(input.sessionId),
        description: result.meta.description,
        keywords: result.meta.keywords,
        ...(domain ? { domain } : {}),
      });
      observer.event('thumbnail.ready', {
        sessionId: input.sessionId,
        svgBytes: written.svgBytes,
        svgMs: Math.round(written.svgMs),
        cardPngBytes: written.cardPngBytes,
        ogPngBytes: written.ogPngBytes,
        rasterMs: Math.round(written.rasterMs),
        unsupportedChars: written.unsupportedChars.length,
        elements: result.meta.thumbnail.elements.length,
        usd: result.usage.usd,
      });
    },
  });
}

type SessionMetaJobsHooks = ConstructorParameters<typeof SessionMetaJobs>[0];
