import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SelectionBand } from '@pen/contracts';
import { nanoid } from 'nanoid';
import type { LessonMemo, LessonMemoEntry } from './types.js';

/**
 * Pen Playground extension of the Canonical Question Memo: reuse a taught lesson
 * (plan + cue script) for the same scope and selection band. Stores no
 * personal state — the band is the only personalisation in the key.
 */
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
      this.entries = JSON.parse(await readFile(this.file, 'utf8')) as LessonMemoEntry[];
    } catch {
      this.entries = [];
    }
    return this.entries;
  }
  private async save(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.entries ?? []));
  }
  async find(canonicalKnowledgeId: string, band: SelectionBand): Promise<LessonMemoEntry | null> {
    const all = await this.load();
    return (
      all
        .filter((e) => e.canonicalKnowledgeId === canonicalKnowledgeId && e.band === band)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }
  async put(
    entry: Omit<LessonMemoEntry, 'id' | 'timesReused' | 'createdAt'>,
  ): Promise<LessonMemoEntry> {
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
  async find(canonicalKnowledgeId: string, band: SelectionBand) {
    return (
      this.entries
        .filter((e) => e.canonicalKnowledgeId === canonicalKnowledgeId && e.band === band)
        .at(-1) ?? null
    );
  }
  async put(entry: Omit<LessonMemoEntry, 'id' | 'timesReused' | 'createdAt'>) {
    const full: LessonMemoEntry = {
      ...entry,
      id: nanoid(10),
      timesReused: 0,
      createdAt: Date.now(),
    };
    this.entries.push(full);
    return full;
  }
  async touch(id: string) {
    const e = this.entries.find((x) => x.id === id);
    if (e) e.timesReused += 1;
  }
}
