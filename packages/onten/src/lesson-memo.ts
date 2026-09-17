import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SelectionBand } from '@pen/contracts';
import { nanoid } from 'nanoid';
import type { LessonMemo, LessonMemoEntry } from './types.js';

/**
 * Pen Playground extension of the Canonical Question Memo: reuse a taught lesson
 * (plan + cue script) for the same scope, selection band and persona. Stores no
 * personal state — the band is the only personalisation in the key. Memos are
 * written segment by segment, so a session that ends early still leaves the
 * segments it generated for the next learner, who generates only the rest.
 */
type NewEntry = Omit<LessonMemoEntry, 'id' | 'timesReused' | 'createdAt'>;
type Segment = { index: number; cues: unknown[]; usd: number };

function pick(
  all: LessonMemoEntry[],
  canonicalKnowledgeId: string,
  band: SelectionBand,
  expertId?: string,
): LessonMemoEntry | null {
  // Newest first; insertion order breaks ties made in the same millisecond.
  const matches = all
    .map((e, order) => ({ e, order }))
    .filter(
      ({ e }) =>
        e.canonicalKnowledgeId === canonicalKnowledgeId &&
        e.band === band &&
        (expertId === undefined || e.expertId === expertId),
    )
    .sort((a, b) => b.e.createdAt - a.e.createdAt || b.order - a.order);
  return matches[0]?.e ?? null;
}

function fill(entry: LessonMemoEntry, segments: Segment[]): void {
  for (const s of segments) {
    if (s.index < 0) continue;
    const existing = entry.cuesBySegment[s.index];
    if (existing && existing.length > 0) continue;
    while (entry.cuesBySegment.length <= s.index) entry.cuesBySegment.push([]);
    while (entry.costUsd.segments.length <= s.index) entry.costUsd.segments.push(0);
    entry.cuesBySegment[s.index] = s.cues;
    entry.costUsd.segments[s.index] = s.usd;
  }
}

/** Older memos on disk predate `costUsd`; treat them as having cost nothing known. */
function normalise(entry: LessonMemoEntry): LessonMemoEntry {
  const raw = entry as Partial<LessonMemoEntry>;
  return {
    ...entry,
    costUsd: raw.costUsd ?? { plan: 0, segments: entry.cuesBySegment.map(() => 0) },
  };
}

export class FileLessonMemo implements LessonMemo {
  private entries: LessonMemoEntry[] | null = null;
  constructor(private readonly dir: string) {}

  private get file() {
    return join(this.dir, 'lesson-memo.json');
  }
  private async load(): Promise<LessonMemoEntry[]> {
    if (this.entries) return this.entries;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as LessonMemoEntry[];
      this.entries = raw.map(normalise);
    } catch {
      this.entries = [];
    }
    return this.entries;
  }
  private async save(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.entries ?? []));
  }
  async find(
    canonicalKnowledgeId: string,
    band: SelectionBand,
    expertId?: string,
  ): Promise<LessonMemoEntry | null> {
    return pick(await this.load(), canonicalKnowledgeId, band, expertId);
  }
  async put(entry: NewEntry): Promise<LessonMemoEntry> {
    const all = await this.load();
    const full: LessonMemoEntry = {
      ...entry,
      id: nanoid(10),
      timesReused: 0,
      createdAt: Date.now(),
    };
    all.push(full);
    await this.save();
    return full;
  }
  async extend(id: string, segments: Segment[]): Promise<void> {
    const e = (await this.load()).find((x) => x.id === id);
    if (!e) return;
    fill(e, segments);
    await this.save();
  }
  async touch(id: string): Promise<void> {
    const all = await this.load();
    const e = all.find((x) => x.id === id);
    if (e) {
      e.timesReused += 1;
      await this.save();
    }
  }
}

export class MemoryLessonMemo implements LessonMemo {
  private readonly entries: LessonMemoEntry[] = [];
  async find(canonicalKnowledgeId: string, band: SelectionBand, expertId?: string) {
    return pick(this.entries, canonicalKnowledgeId, band, expertId);
  }
  async put(entry: NewEntry) {
    const full: LessonMemoEntry = {
      ...entry,
      id: nanoid(10),
      timesReused: 0,
      createdAt: Date.now(),
    };
    this.entries.push(full);
    return full;
  }
  async extend(id: string, segments: Segment[]) {
    const e = this.entries.find((x) => x.id === id);
    if (e) fill(e, segments);
  }
  async touch(id: string) {
    const e = this.entries.find((x) => x.id === id);
    if (e) e.timesReused += 1;
  }
}
