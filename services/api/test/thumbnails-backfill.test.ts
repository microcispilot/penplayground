import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connect, SessionRepository } from '@pen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THUMB_FILES } from '../src/thumbnails.js';

/**
 * `pnpm --filter @pen/api thumbnails:backfill` as the operator runs it: a real
 * process, a real (file-backed) database, the fake providers. The dry run must
 * touch nothing and still price the work; the real run must leave a generated
 * picture and both derived sizes on disk, plus a patched record, for every
 * session that had none. `--redraw` must find the pre-ADR-0021 sketches too.
 *
 * A backfill belongs to no learner, so every call it makes is on the platform
 * key; `PEN_LLM_PROVIDER=fake` supplies it here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'thumbnails-backfill.ts');
const run = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), 'pen-backfill-'));
const databaseUrl = `pglite://${join(dataDir, 'db')}`;

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  topic: 'How Transformers work in LLMs',
  title: 'How Transformers work in LLMs',
  promise: 'Read an attention diagram and explain why every piece is there.',
  expertId: 'nova-ai-expert',
  hostId: 'p_host_backfil',
  hostName: 'Sam',
  band: 'beginner' as const,
  domain: 'computing-data',
  visibility: 'public' as const,
  startedAt: Date.now() - 86_400_000,
  endedAt: Date.now() - 86_000_000,
  durationMs: 840_000,
  segments: 3,
  questions: 0,
  recap: [],
  views: 0,
  thumbnail: null,
  canonicalId: 'en.how-transformers-work-in-llms',
  language: 'en-US',
  description: '',
  keywords: [],
  likes: 0,
  ...extra,
});

async function withDb<T>(fn: (repo: SessionRepository) => Promise<T>): Promise<T> {
  // One process at a time on a PGlite directory: the script gets it alone.
  const db = await connect(databaseUrl);
  try {
    return await fn(new SessionRepository(db.db));
  } finally {
    await db.close();
  }
}

async function backfill(...args: string[]) {
  return run(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PEN_JWT_SECRET: 'x'.repeat(40),
      PEN_DATA_DIR: dataDir,
      DATABASE_URL: databaseUrl,
      PEN_LLM_PROVIDER: 'fake',
      PEN_TTS_PROVIDER: 'silent',
      PEN_STT_PROVIDER: 'browser',
      PEN_LOG_LEVEL: 'silent',
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

beforeAll(async () => {
  await withDb(async (repo) => {
    await repo.upsert(record('s_backfill_01'));
    // The same lesson as 01: the second one must cost nothing.
    await repo.upsert(record('s_backfill_02'));
    await repo.upsert(
      record('s_backfill_03', { thumbnail: '/api/sessions/s_backfill_03/thumb.svg' }),
    );
    // Still being taught: its own job owns it.
    await repo.upsert(record('s_backfill_04', { startedAt: Date.now(), endedAt: null }));
  });
}, 120_000);

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('thumbnails:backfill', () => {
  it('--dry-run lists the work and its price, and writes nothing', async () => {
    const { stdout } = await backfill('--dry-run');
    expect(stdout).toMatch(
      /3 sessions without a picture \(limit 500, copy fake, picture fake low, concurrency 2\)/,
    );
    expect(stdout).toMatch(/skip s_backfill_04 {2}still live/);
    expect(stdout).toMatch(/2 pictures to generate · 2 card copies to write/);
    expect(stdout).toMatch(/estimated cost: \$0\.0000/);
    expect(stdout).toMatch(/would generate s_backfill_01 {2}en-US {2}3 seg/);
    expect(stdout).toMatch(/would generate s_backfill_02/);
    expect(stdout).toMatch(/dry run: nothing was written\./);
    expect(existsSync(join(dataDir, 'sessions', 's_backfill_01', THUMB_FILES.source))).toBe(false);
    await withDb(async (repo) => {
      expect((await repo.get('s_backfill_01'))?.thumbnail).toBeNull();
    });
  }, 120_000);

  it('--limit bounds the walk', async () => {
    const { stdout } = await backfill('--dry-run', '--limit', '1');
    expect(stdout).toMatch(/1 session without a picture \(limit 1,/);
  }, 120_000);

  it('draws what is missing, reuses the second session on the same lesson, and patches the records', async () => {
    const { stdout } = await backfill();
    // The first session pays for the card; the second is the same lesson, so it costs nothing.
    expect(stdout).toMatch(/drew\s+s_backfill_0[12]/);
    expect(stdout).toMatch(/reused\s+s_backfill_0[12]/);
    expect(stdout).toMatch(/done: 1 drawn, 1 reused, 0 repaired, 0 failed/);
    for (const id of ['s_backfill_01', 's_backfill_02']) {
      for (const file of [THUMB_FILES.source, THUMB_FILES.card, THUMB_FILES.og, THUMB_FILES.meta])
        expect(existsSync(join(dataDir, 'sessions', id, file)), `${id}/${file}`).toBe(true);
      // Nothing draws a sketch any more.
      expect(existsSync(join(dataDir, 'sessions', id, THUMB_FILES.svg)), id).toBe(false);
    }
    await withDb(async (repo) => {
      const one = await repo.get('s_backfill_01');
      expect(one?.thumbnail).toBe('/api/sessions/s_backfill_01/thumb.webp');
      expect(one?.description).toMatch(/attention/i);
      expect(one?.keywords).toContain('transformers');
      // The live one was never touched.
      expect((await repo.get('s_backfill_04'))?.thumbnail).toBeNull();
    });
  }, 180_000);

  it('is idempotent: a second run has nothing left to draw', async () => {
    const { stdout } = await backfill();
    expect(stdout).toMatch(/1 session without a picture/);
    expect(stdout).toMatch(/done: 0 drawn, 0 reused, 0 repaired, 0 failed/);
  }, 120_000);

  /**
   * The sessions the owner is actually looking at: taught before ADR-0021 and
   * still showing a hand-drawn sketch. They are invisible to a plain run — the
   * record has a thumbnail — and `--redraw` is the only thing that finds them.
   */
  it('--redraw finds a session still showing a pre-ADR-0021 sketch', async () => {
    const plain = await backfill('--dry-run');
    expect(plain.stdout).not.toMatch(/s_backfill_03/);
    const { stdout } = await backfill('--dry-run', '--redraw');
    expect(stdout).toMatch(/still showing a sketch/);
    expect(stdout).toMatch(/s_backfill_03/);
    expect(stdout).toMatch(/dry run: nothing was written\./);
  }, 120_000);

  it('repairs a record whose files are already on disk without calling the model', async () => {
    await withDb(async (repo) => {
      await repo.patch('s_backfill_01', { thumbnail: null, description: '', keywords: [] });
    });
    const { stdout } = await backfill();
    expect(stdout).toMatch(/1 already rendered/);
    expect(stdout).toMatch(/repaired s_backfill_01/);
    expect(stdout).toMatch(/done: 0 drawn, 0 reused, 1 repaired, 0 failed/);
    await withDb(async (repo) => {
      const one = await repo.get('s_backfill_01');
      expect(one?.thumbnail).toBe('/api/sessions/s_backfill_01/thumb.webp');
      expect(one?.description).toMatch(/attention/i);
    });
  }, 120_000);

  it('refuses an argument it does not understand', async () => {
    await expect(backfill('--nope')).rejects.toThrow(/unknown argument/);
  }, 120_000);

  /**
   * `--reencode` (ADR-0022): the pass that moves ADR-0021's PNG cards onto
   * WebP and JPEG. It is the one mode that cannot spend anything — every
   * session it touches already has the generation that paid for it — so the
   * test that matters is that no provider is asked for anything at all.
   */
  describe('--reencode', () => {
    it('will not run alongside --redraw, so a free pass is never mistaken for a paid one', async () => {
      await expect(backfill('--redraw', '--reencode')).rejects.toThrow(
        /--redraw generates and --reencode never does/,
      );
    }, 120_000);

    it('re-derives a PNG card into WebP + JPEG, repoints the record, and spends nothing', async () => {
      // Put s_backfill_01 back where ADR-0021 left it: a record pointing at
      // `thumb.png`, with `source.png` still beside it.
      const dir = join(dataDir, 'sessions', 's_backfill_01');
      expect(existsSync(join(dir, THUMB_FILES.source))).toBe(true);
      copyFileSync(join(dir, THUMB_FILES.card), join(dir, THUMB_FILES.cardPng));
      copyFileSync(join(dir, THUMB_FILES.og), join(dir, THUMB_FILES.ogPng));
      rmSync(join(dir, THUMB_FILES.card));
      rmSync(join(dir, THUMB_FILES.og));
      await withDb(async (repo) => {
        await repo.patch('s_backfill_01', {
          thumbnail: '/api/sessions/s_backfill_01/thumb.png',
        });
      });

      const dry = await backfill('--reencode', '--dry-run');
      expect(dry.stdout).toMatch(/1 session still on a PNG card/);
      expect(dry.stdout).toMatch(/would re-encode\s+s_backfill_01/);
      expect(existsSync(join(dir, THUMB_FILES.card))).toBe(false);

      const { stdout } = await backfill('--reencode');
      expect(stdout).toMatch(/no API calls, \$0\.0000/);
      expect(stdout).toMatch(/re-encoded s_backfill_01/);
      expect(stdout).toMatch(/done: 1 re-encoded, 0 without a source · .*spent \$0\.0000/);
      expect(existsSync(join(dir, THUMB_FILES.card))).toBe(true);
      expect(existsSync(join(dir, THUMB_FILES.og))).toBe(true);
      // The pair it supersedes stays: those URLs are in unfurl caches.
      expect(existsSync(join(dir, THUMB_FILES.cardPng))).toBe(true);
      expect(existsSync(join(dir, THUMB_FILES.ogPng))).toBe(true);
      await withDb(async (repo) => {
        expect((await repo.get('s_backfill_01'))?.thumbnail).toBe(
          '/api/sessions/s_backfill_01/thumb.webp',
        );
      });
      // Idempotent: nothing points at a PNG any more, so there is nothing left.
      expect((await backfill('--reencode')).stdout).toMatch(/0 sessions still on a PNG card/);
    }, 120_000);

    it('skips a session whose source is gone rather than inventing one', async () => {
      await withDb(async (repo) => {
        await repo.upsert(
          record('s_backfill_05', { thumbnail: '/api/sessions/s_backfill_05/thumb.png' }),
        );
      });
      const dry = await backfill('--reencode', '--dry-run');
      expect(dry.stdout).toMatch(/would skip\s+s_backfill_05\s+\(no source\.png\)/);
      const { stdout } = await backfill('--reencode');
      expect(stdout).toMatch(/skip s_backfill_05\s+no source\.png to derive from/);
      expect(stdout).toMatch(/done: 0 re-encoded, 1 without a source/);
      // Its record is untouched: the card it has is the only one it can have.
      await withDb(async (repo) => {
        expect((await repo.get('s_backfill_05'))?.thumbnail).toBe(
          '/api/sessions/s_backfill_05/thumb.png',
        );
      });
    }, 120_000);
  });
});
