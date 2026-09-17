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
  ...extra,
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
