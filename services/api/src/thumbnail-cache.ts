import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ThumbnailQuality } from '@pen/contracts';
import type {
  CachedThumbnailImage,
  ThumbnailImageCacheKey,
  ThumbnailImageCachePort,
} from '@pen/session-engine';
import { z } from 'zod';

/**
 * Pictures already generated, kept between sessions (ADR-0021). The key is the
 * lesson memo's scope plus the title the picture was drawn from, so the second
 * session on a topic shows the first one's photograph without paying the
 * ~$0.016 again — exactly as it replays the memo's lesson and reuses its card
 * copy.
 *
 * Two files per entry under `<data>/onten/thumbnail-images/`: `<key>.png` with
 * the bytes and `<key>.json` with what the generation cost, so a reuse can say
 * precisely what it saved instead of estimating. The bytes are 1.5–2 MB each,
 * which is why they are files and not rows in the card cache's JSON.
 *
 * The store is capped by total bytes, oldest entry out first, so a long-lived
 * node cannot fill its disk with pictures of topics nobody asks for any more.
 */
const StoredMeta = z.object({
  version: z.literal(1),
  titleDigest: z.string().min(1).max(64),
  usd: z.number().nonnegative(),
  model: z.string().max(80),
  quality: ThumbnailQuality,
  bytes: z.number().int().nonnegative(),
  createdAt: z.number().int(),
});

export const THUMBNAIL_CACHE_DIR = 'thumbnail-images';
/** Roughly 500 pictures at ~2 MB each. */
export const THUMBNAIL_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

export class FileThumbnailImageCache implements ThumbnailImageCachePort {
  private readonly dir: string;
  /** Writes are serialised through one chain: two jobs finishing together never interleave a sweep. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly maxBytes: number = THUMBNAIL_CACHE_MAX_BYTES,
  ) {
    this.dir = join(dataDir, THUMBNAIL_CACHE_DIR);
  }

  /** A scope is free-form text; the file name must not be. */
  private name(key: ThumbnailImageCacheKey): string {
    return createHash('sha256').update(key.scope).digest('base64url').slice(0, 32);
  }

  async get(key: ThumbnailImageCacheKey): Promise<CachedThumbnailImage | null> {
    const base = join(this.dir, this.name(key));
    if (!existsSync(`${base}.json`) || !existsSync(`${base}.png`)) return null;
    let parsed: z.infer<typeof StoredMeta>;
    try {
      const raw = StoredMeta.safeParse(JSON.parse(readFileSync(`${base}.json`, 'utf8')));
      // A file we cannot read is a cold cache, never a failed session.
      if (!raw.success) return null;
      parsed = raw.data;
    } catch {
      return null;
    }
    // A lesson that was re-planned under a new title is a different picture.
    if (parsed.titleDigest !== key.titleDigest) return null;
    const png = readFileSync(`${base}.png`);
    if (png.subarray(0, 4).toString('hex') !== '89504e47') return null;
    return { png, usd: parsed.usd, model: parsed.model, quality: parsed.quality };
  }

  async put(key: ThumbnailImageCacheKey, value: CachedThumbnailImage): Promise<void> {
    const base = join(this.dir, this.name(key));
    const meta: z.infer<typeof StoredMeta> = {
      version: 1,
      titleDigest: key.titleDigest,
      usd: value.usd,
      model: value.model,
      quality: value.quality,
      bytes: value.png.length,
      createdAt: Date.now(),
    };
    this.writing = this.writing.then(() => {
      mkdirSync(this.dir, { recursive: true });
      // Write-then-rename: a crash mid-write leaves the previous entry, never half a picture.
      const tmp = `${base}.${process.pid}.tmp`;
      writeFileSync(tmp, value.png);
      renameSync(tmp, `${base}.png`);
      writeFileSync(`${base}.json`, JSON.stringify(meta));
      this.sweep();
    });
    await this.writing;
  }

  /** Drop the oldest entries until the store is back inside its byte cap. */
  private sweep(): void {
    const entries = readdirSync(this.dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => {
        const st = statSync(join(this.dir, f));
        return { name: f.slice(0, -4), bytes: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      rmSync(join(this.dir, `${entry.name}.png`), { force: true });
      rmSync(join(this.dir, `${entry.name}.json`), { force: true });
      total -= entry.bytes;
    }
  }

  /** Pictures currently held (the backfill prints it; tests assert on it). */
  size(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).filter((f) => f.endsWith('.png')).length;
  }
}
