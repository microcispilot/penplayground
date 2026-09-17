import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Session index for Home ("Most learned"), My sessions and share pages.
 * File-backed today; the `db` package's Postgres repository replaces it behind
 * the same methods.
 */
export const SessionRecord = z.object({
  id: z.string(),
  topic: z.string(),
  title: z.string(),
  promise: z.string(),
  expertId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  band: z.enum(['beginner', 'intermediate', 'advanced']),
  domain: z.string(),
  /** Public sessions appear on Home; private ones only in the host's list. */
  visibility: z.enum(['public', 'private']),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  segments: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
  recap: z.array(z.string()),
  /** Times this session's replay was opened. */
  views: z.number().int().nonnegative(),
  thumbnail: z.string().nullable(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export class SessionStore {
  private records: Map<string, SessionRecord> | null = null;
  constructor(private readonly dir: string) {}

  private get file() {
    return join(this.dir, 'index.json');
  }
  private load(): Map<string, SessionRecord> {
    if (this.records) return this.records;
    mkdirSync(this.dir, { recursive: true });
    const map = new Map<string, SessionRecord>();
    if (existsSync(this.file)) {
      const parsed = z.array(SessionRecord).safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) for (const r of parsed.data) map.set(r.id, r);
    }
    this.records = map;
    return map;
  }
  private save(): void {
    writeFileSync(this.file, JSON.stringify([...this.load().values()]));
  }
  upsert(record: SessionRecord): void {
    this.load().set(record.id, record);
    this.save();
  }
  patch(id: string, patch: Partial<SessionRecord>): SessionRecord | null {
    const r = this.load().get(id);
    if (!r) return null;
    const next = { ...r, ...patch };
    this.load().set(id, next);
    this.save();
    return next;
  }
  get(id: string): SessionRecord | null {
    return this.load().get(id) ?? null;
  }
  listPublic(limit = 48): SessionRecord[] {
    return [...this.load().values()]
      .filter((r) => r.visibility === 'public' && r.endedAt !== null)
      .sort((a, b) => b.views - a.views || b.startedAt - a.startedAt)
      .slice(0, limit);
  }
  listForHost(hostId: string): SessionRecord[] {
    return [...this.load().values()]
      .filter((r) => r.hostId === hostId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}
