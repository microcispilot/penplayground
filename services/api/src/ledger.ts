import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LedgerEntry } from '@pen/contracts';
import { LedgerEntry as LedgerEntrySchema } from '@pen/contracts';
import type { LedgerSink } from '@pen/session-engine';

/**
 * Recording ledger on disk: `<dir>/<sessionId>/ledger.jsonl` for events and
 * `<dir>/<sessionId>/audio/<sayId>.<take>.pcm` for raw s16le audio (chunks are
 * appended in order; the ledger's audioRef points at `file#byteOffset`).
 * Object storage replaces this adapter in production; the seam is `LedgerSink`.
 */
export class FileLedger implements LedgerSink {
  private readonly offsets = new Map<string, number>();
  constructor(private readonly dir: string) {}

  private sessionDir(sessionId: string): string {
    const d = join(this.dir, safeId(sessionId));
    mkdirSync(join(d, 'audio'), { recursive: true });
    return d;
  }

  append(sessionId: string, entry: LedgerEntry): void {
    appendFileSync(join(this.sessionDir(sessionId), 'ledger.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  storeAudio(
    sessionId: string,
    sayId: string,
    take: number,
    _chunkId: number,
    pcm: Uint8Array,
  ): string {
    const file = join(this.sessionDir(sessionId), 'audio', `${safeId(sayId)}.${take}.pcm`);
    const key = `${sessionId}|${file}`;
    const offset = this.offsets.get(key) ?? 0;
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, pcm);
    } finally {
      closeSync(fd);
    }
    this.offsets.set(key, offset + pcm.length);
    return `${safeId(sayId)}.${take}.pcm#${offset}`;
  }

  read(sessionId: string): LedgerEntry[] {
    const file = join(this.dir, safeId(sessionId), 'ledger.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      });
  }

  /** Every session with a ledger on disk (for reuse statistics across sessions). */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.dir, d.name, 'ledger.jsonl')))
      .map((d) => d.name);
  }

  /**
   * Erase everything this session left on disk: the ledger, its audio, the
   * rendered thumbnails and any export, which all live under the one session
   * directory. Returns false when there was nothing there.
   */
  remove(sessionId: string): boolean {
    const dir = join(this.dir, safeId(sessionId));
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    for (const key of [...this.offsets.keys()])
      if (key.startsWith(`${sessionId}|`)) this.offsets.delete(key);
    return true;
  }

  audioPath(sessionId: string, file: string): string | null {
    if (!/^[A-Za-z0-9_.-]+\.pcm$/.test(file)) return null;
    const p = join(this.dir, safeId(sessionId), 'audio', file);
    return existsSync(p) ? p : null;
  }
}

export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}
