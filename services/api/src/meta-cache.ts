import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionMeta as SessionMetaSchema } from '@pen/contracts';
import type {
  CachedSessionMeta,
  SessionMetaCacheKey,
  SessionMetaCachePort,
} from '@pen/session-engine';
import { z } from 'zod';

/**
 * Cards and sketches kept between sessions (ADR-0013). The key is the lesson
 * memo's scope — same canonical topic, band, persona and language — so the
 * second session on a topic shows the first one's sketch and description with
 * zero model calls, exactly as it replays the memo's lesson.
 *
 * One JSON file beside `lesson-memo.json`, loaded once per process: entries
 * are ~2 KB and there is one per scope, so the whole cache is smaller than a
 * single session's ledger. A scope keeps only its newest card (a re-planned
 * lesson replaces it), and the file is capped so a long-lived node cannot
 * grow it without bound.
 */
const StoredEntry = z.object({
  planDigest: z.string().min(1).max(64),
  meta: SessionMetaSchema,
  usd: z.number().nonnegative(),
  model: z.string().max(80),
  createdAt: z.number().int(),
});
type StoredEntry = z.infer<typeof StoredEntry>;

/**
 * Version 2 since ADR-0022. The bump is the invalidation: a version-1 file
 * fails this parse and `load()` treats an unreadable file as a cold cache, so
 * every card written before the copy call learned to name a photographic
 * subject is written again. Without it a scope cached earlier would replay
 * `subject: ''` for good — the entry parses fine, because the field defaults —
 * and its thumbnail would silently keep the title-only prompt. One cheap copy
 * call per scope (~$0.0002) is the whole price of not having that.
 */
const StoredFile = z.object({
  version: z.literal(2),
  entries: z.record(z.string(), StoredEntry),
});

export const META_CACHE_FILE = 'session-meta-cache.json';
/** Roughly 2 MB of cards; the oldest are dropped first. */
export const META_CACHE_MAX_ENTRIES = 1000;

export class FileSessionMetaCache implements SessionMetaCachePort {
  private entries: Map<string, StoredEntry> | null = null;
  /** Writes are serialised through one chain: two jobs finishing together never interleave. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly maxEntries: number = META_CACHE_MAX_ENTRIES,
  ) {}

  private get file(): string {
    return join(this.dir, META_CACHE_FILE);
  }

  private load(): Map<string, StoredEntry> {
    if (this.entries) return this.entries;
    try {
      const parsed = StoredFile.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      // A file we cannot read is a cold cache, never a failed session.
      this.entries = new Map(parsed.success ? Object.entries(parsed.data.entries) : []);
    } catch {
      this.entries = new Map();
    }
    return this.entries;
  }

  async get(key: SessionMetaCacheKey): Promise<CachedSessionMeta | null> {
    const entry = this.load().get(key.scope);
    // A changed lesson (a re-planned memo, a renamed segment) is a different card.
    if (!entry || entry.planDigest !== key.planDigest) return null;
    return { meta: entry.meta, planDigest: entry.planDigest, usd: entry.usd, model: entry.model };
  }

  async put(key: SessionMetaCacheKey, value: CachedSessionMeta): Promise<void> {
    const entries = this.load();
    entries.delete(key.scope);
    entries.set(key.scope, {
      planDigest: key.planDigest,
      meta: value.meta,
      usd: value.usd,
      model: value.model,
      createdAt: Date.now(),
    });
    // Insertion order is age order: the oldest scopes fall out first.
    while (entries.size > this.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    const snapshot = JSON.stringify({
      version: 2,
      entries: Object.fromEntries(entries),
    } satisfies z.input<typeof StoredFile>);
    this.writing = this.writing.then(() => {
      mkdirSync(this.dir, { recursive: true });
      // Write-then-rename: a crash mid-write leaves the previous cache, never half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, snapshot);
      renameSync(tmp, this.file);
    });
    await this.writing;
  }

  /** Entries currently held (the backfill prints it; tests assert on it). */
  size(): number {
    return this.load().size;
  }
}
