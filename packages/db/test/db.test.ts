import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Connection,
  connect,
  ParticipantRepository,
  SessionRepository,
} from '../src/index.js';

let conn: Connection;
beforeAll(async () => {
  conn = await connect('pglite://memory');
});
afterAll(async () => {
  await conn.close();
});

const record = (id: string, extra: Partial<Parameters<SessionRepository['upsert']>[0]> = {}) => ({
  id,
  topic: 'Swift',
  title: 'Swift Fundamentals',
  promise: '',
  expertId: 'juno',
  hostId: 'host-1',
  hostName: 'Sam',
  band: 'beginner' as const,
  domain: 'computing-data',
  visibility: 'public' as const,
  startedAt: Date.now(),
  endedAt: null,
  durationMs: 0,
  segments: 0,
  questions: 0,
  recap: [],
  views: 0,
  thumbnail: null,
  canonicalId: null,
  language: 'en-US',
  description: '',
  keywords: [],
  likes: 0,
  ...extra,
});

describe('Connection', () => {
  it('pings while the database is open and rejects once it is closed', async () => {
    await expect(conn.ping()).resolves.toBeUndefined();
    // The readiness probe (`GET /api/ready`) turns exactly this rejection into a 503.
    const other = await connect('pglite://memory');
    await other.close();
    await expect(other.ping()).rejects.toThrow();
  });
});

describe('SessionRepository', () => {
  it('upserts, patches, lists public (ended only) and per host, counts today', async () => {
    const repo = new SessionRepository(conn.db);
    await repo.upsert(record('a'));
    await repo.upsert(record('b', { endedAt: Date.now(), views: 3, recap: ['x'] }));
    await repo.upsert(record('c', { hostId: 'host-2', endedAt: Date.now(), views: 9 }));
    expect((await repo.listPublic()).map((s) => s.id)).toEqual(['c', 'b']);
    expect((await repo.listForHost('host-1')).map((s) => s.id).sort()).toEqual(['a', 'b']);
    await repo.recordView('b');
    expect((await repo.get('b'))?.views).toBe(4);
    const patched = await repo.patch('a', { endedAt: 1, recap: ['done'] });
    expect(patched?.recap).toEqual(['done']);
    expect(await repo.countToday('host-1')).toBe(2);
    expect(await repo.get('nope')).toBeNull();
  });

  it('lists the sessions a backfill has to draw, newest first, and drops them once drawn', async () => {
    const repo = new SessionRepository(conn.db);
    await repo.upsert(record('t1', { startedAt: 1_000, language: 'fa-IR' }));
    await repo.upsert(record('t2', { startedAt: 2_000, thumbnail: '/api/sessions/t2/thumb.svg' }));
    await repo.upsert(record('t3', { startedAt: 3_000 }));
    // The rows this case added, newest first; `t2` already has its sketch.
    const mine = (rows: Array<{ id: string }>) =>
      rows.map((s) => s.id).filter((id) => id[0] === 't');
    const pending = await repo.listWithoutThumbnail();
    expect(mine(pending)).toEqual(['t3', 't1']);
    expect(pending.find((s) => s.id === 't1')?.language).toBe('fa-IR');
    // Sessions written before the column exists read as the default, never null.
    expect(pending.find((s) => s.id === 't3')?.language).toBe('en-US');
    await repo.patch('t3', { thumbnail: '/api/sessions/t3/thumb.svg' });
    expect(mine(await repo.listWithoutThumbnail())).toEqual(['t1']);
  });
});

describe('ParticipantRepository', () => {
  it('ensures and updates plan', async () => {
    const repo = new ParticipantRepository(conn.db);
    const p = await repo.ensure({ id: 'p_abcdefgh', name: 'Sam', plan: 'free', anonymous: true });
    expect(p.plan).toBe('free');
    await repo.setPlan('p_abcdefgh', 'standard', 'cus_1');
    expect((await repo.get('p_abcdefgh'))?.plan).toBe('standard');
    const again = await repo.ensure({
      id: 'p_abcdefgh',
      name: 'Samantha',
      plan: 'free',
      anonymous: true,
    });
    expect(again.name).toBe('Samantha');
    expect(again.plan).toBe('standard');
  });
});
