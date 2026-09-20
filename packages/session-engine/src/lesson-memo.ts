import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SelectionBand } from '@pen/contracts';
import { nanoid } from 'nanoid';

/**
 * Pen Playground's own cache of the lessons it has already generated: reuse a
 * taught lesson (plan + cue script) for the same scope, selection band, persona
 * and language. Stores no personal state — the band is the only personalisation
 * in the key. Memos are written segment by segment, so a session that ends early
 * still leaves the segments it generated for the next learner, who generates
 * only the rest.
 *
 * **This is not Onten's Canonical Question Memo, and must never be confused with
 * it.** Onten's memo (CTX-MEMO-01) caches a *selection* — which knowledge units
 * answer a question — and lives inside `MockContextRuntime`. This one caches
 * *generated lesson text*: sentences a language model wrote from the context
 * Onten supplied. Onten never saw it, never produced it, and will never store
 * it, whatever SDK is behind the interface. It belongs to the room, so it lives
 * with the room (ADR-0019, `docs/ONTEN-BOUNDARY.md`).
 *
 * Its sibling is the lesson voice store (ADR-0017): the same scope key, the same
 * ownership, one holding the words and the other the audio of those words.
 */

/** One taught lesson, keyed by scope + band + language (+ persona). */
export interface LessonMemoEntry {
  id: string;
  canonicalKnowledgeId: string;
  band: SelectionBand;
  /**
   * BCP-47 language the lesson was taught in. A memo is a script of spoken
   * sentences and board text, so it can only be replayed for a learner in the
   * same language; entries written before this field are English.
   */
  language: string;
  packId: string;
  packRevision: string;
  expertId: string;
  /** Serialized LessonPlan. */
  plan: unknown;
  /**
   * Serialized lesson cues (the narration + board script), by segment. Grows
   * as sessions get further into the lesson: an empty slot means "not taught
   * yet", and the next session generates only that segment.
   */
  cuesBySegment: unknown[][];
  /** What generating the plan and each segment cost (USD), so a reuse can report exactly what it saved. */
  costUsd: { plan: number; segments: number[] };
  timesReused: number;
  createdAt: number;
}

export interface LessonMemo {
  /**
   * The latest memo for the scope, band and language; for one persona when
   * `expertId` is given (scripts carry the persona's voice). `language` is
   * matched on its subtag (`fa-IR` replays an `fa` memo) and defaults to
   * English, which is what entries written before the field hold.
   */
  find(
    canonicalKnowledgeId: string,
    band: SelectionBand,
    expertId?: string,
    language?: string,
    /** Only a memo written from this exact pack revision; omitted, any. */
    pack?: { packId: string; packRevision: string },
  ): Promise<LessonMemoEntry | null>;
  put(entry: Omit<LessonMemoEntry, 'id' | 'timesReused' | 'createdAt'>): Promise<LessonMemoEntry>;
  /** Fill segments a later session generated (never overwrites a segment already memoised). */
  extend(
    id: string,
    segments: Array<{ index: number; cues: unknown[]; usd: number }>,
  ): Promise<void>;
  touch(id: string): Promise<void>;
}

type NewEntry = Omit<LessonMemoEntry, 'id' | 'timesReused' | 'createdAt'>;
type Segment = { index: number; cues: unknown[]; usd: number };

/** Packs are keyed by language, never by region: `fa-IR` and `fa` are the same lesson. */
function subtag(language: string): string {
  return (language.split('-')[0] ?? language).toLowerCase();
}

function pick(
  all: LessonMemoEntry[],
  canonicalKnowledgeId: string,
  band: SelectionBand,
  expertId?: string,
  language = 'en',
  pack?: { packId: string; packRevision: string },
): LessonMemoEntry | null {
  const want = subtag(language);
  // Newest first; insertion order breaks ties made in the same millisecond.
  const matches = all
    .map((e, order) => ({ e, order }))
    .filter(
      ({ e }) =>
        e.canonicalKnowledgeId === canonicalKnowledgeId &&
        e.band === band &&
        // A memo is spoken sentences: replaying it for another language would teach in the wrong one.
        subtag(e.language) === want &&
        (expertId === undefined || e.expertId === expertId) &&
        // And it is only the lesson this knowledge produced. When the pack it
        // was written from is superseded — a revision, or a different pack for
        // the same topic — the memo is stale by definition: the next learner
        // would be taught from knowledge we have since improved.
        (pack === undefined || (e.packId === pack.packId && e.packRevision === pack.packRevision)),
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

/**
 * Older memos on disk predate `costUsd` and `language`: they cost nothing
 * known, and every lesson taught before the field was English.
 */
function normalise(entry: LessonMemoEntry): LessonMemoEntry {
  const raw = entry as Partial<LessonMemoEntry>;
  return {
    ...entry,
    costUsd: raw.costUsd ?? { plan: 0, segments: entry.cuesBySegment.map(() => 0) },
    language: raw.language ?? 'en',
  };
}

export interface FileLessonMemoOptions {
  /**
   * Where a failure to read or write the file goes. The API hands it the
   * session observer, so it reaches Sentry: losing this cache is expensive
   * and must never be something we find out about from the bill.
   */
  onError?: (scope: string, error: unknown) => void;
}

/**
 * The memo as a file, which is what production runs on
 * (`services/api/src/services.ts`).
 *
 * Two things this has to get right, because the file *is* the cache that
 * stops every lesson being written and spoken twice:
 *
 * **A save is all-or-nothing.** It used to be a plain `writeFile` over the
 * destination, which truncates and then streams. A reader during that window
 * sees half a document — measured through this class: a 388 KB memo, 36 of 40
 * saves left at least one unparseable read behind them — and a process killed
 * in it (a deploy, an OOM) leaves the file that way for good. So the body goes
 * to a temporary file and is `rename`d over the destination, which is atomic:
 * a reader sees the old document or the new one, never a seam. Saves are
 * queued behind one another too, so two rooms finishing a segment together
 * cannot interleave.
 *
 * **A file we could not read is not an empty file.** The old `load` caught
 * everything and answered "no memos", and the next save wrote that over the
 * file: one bad read, and every lesson the deployment had ever taught was
 * gone, silently. A missing file is a first run and says nothing; anything
 * else is reported, and the memo refuses to write until someone has looked.
 */
export class FileLessonMemo implements LessonMemo {
  private entries: LessonMemoEntry[] | null = null;
  /** The one read this instance will do, claimed in `load`'s first tick. */
  private loading: Promise<LessonMemoEntry[]> | null = null;
  /** Saves run one at a time, in the order they were asked for. */
  private writing: Promise<void> = Promise.resolve();
  /** The file exists and could not be read: hold what is there for recovery. */
  private unreadable = false;

  constructor(
    private readonly dir: string,
    private readonly o: FileLessonMemoOptions = {},
  ) {}

  private get file() {
    return join(this.dir, 'lesson-memo.json');
  }
  private load(): Promise<LessonMemoEntry[]> {
    // Claimed in the same tick as the miss: two callers arriving together used
    // to parse the file twice into two different arrays, and whichever landed
    // second became `this.entries` while the first was still being written to.
    this.loading ??= this.read();
    return this.loading;
  }
  private async read(): Promise<LessonMemoEntry[]> {
    await mkdir(this.dir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      // No file is a first run, and the only silent case there is.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unreadable = true;
        this.o.onError?.('lesson_memo.unreadable', error);
      }
      this.entries = [];
      return this.entries;
    }
    try {
      this.entries = (JSON.parse(raw) as LessonMemoEntry[]).map(normalise);
    } catch (error) {
      this.unreadable = true;
      this.o.onError?.('lesson_memo.unreadable', error);
      this.entries = [];
    }
    return this.entries;
  }
  private save(): Promise<void> {
    if (this.unreadable) return Promise.resolve();
    // Serialised here, so the body is the array as it stands at this moment.
    const body = JSON.stringify(this.entries ?? []);
    const next = this.writing.then(() => this.write(body));
    // The queue survives a failed write; this caller still hears about it.
    this.writing = next.catch(() => undefined);
    return next;
  }
  private async write(body: string): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${nanoid(8)}.tmp`;
    try {
      await writeFile(tmp, body);
      await rename(tmp, this.file);
    } catch (error) {
      this.o.onError?.('lesson_memo.write', error);
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  async find(
    canonicalKnowledgeId: string,
    band: SelectionBand,
    expertId?: string,
    language?: string,
    pack?: { packId: string; packRevision: string },
  ): Promise<LessonMemoEntry | null> {
    return pick(await this.load(), canonicalKnowledgeId, band, expertId, language, pack);
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
  async find(
    canonicalKnowledgeId: string,
    band: SelectionBand,
    expertId?: string,
    language?: string,
    pack?: { packId: string; packRevision: string },
  ) {
    return pick(this.entries, canonicalKnowledgeId, band, expertId, language, pack);
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
