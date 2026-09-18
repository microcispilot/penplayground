import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Connection, connect, ListRepository, SessionRepository } from '../src/index.js';

let conn: Connection;
let lists: ListRepository;
let sessions: SessionRepository;

beforeAll(async () => {
  conn = await connect('pglite://memory');
  lists = new ListRepository(conn.db);
  sessions = new SessionRepository(conn.db);
  for (const [id, hostId] of [
    ['s_one', 'p_host_a'],
    ['s_two', 'p_host_a'],
    ['s_three', 'p_host_b'],
  ] as const)
    await sessions.upsert({
      id,
      topic: 'Swift',
      title: `Session ${id}`,
      promise: '',
      expertId: 'juno',
      hostId,
      hostName: 'Sam',
      band: 'beginner',
      domain: 'computing-data',
      visibility: 'public',
      startedAt: Date.now(),
      endedAt: Date.now(),
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
    });
});
afterAll(async () => {
  await conn.close();
});

describe('ListRepository', () => {
  it('saves are idempotent pairs, newest first, and unsave reports whether anything was there', async () => {
    expect(await lists.save('p_alice', 's_one', 1000)).toBe(true);
    expect(await lists.save('p_alice', 's_one', 2000)).toBe(false);
    expect(await lists.save('p_alice', 's_two', 3000)).toBe(true);
    expect((await lists.savedFor('p_alice')).map((s) => s.id)).toEqual(['s_two', 's_one']);
    expect(await lists.unsave('p_alice', 's_one')).toBe(true);
    expect(await lists.unsave('p_alice', 's_one')).toBe(false);
    expect((await lists.savedFor('p_alice')).map((s) => s.id)).toEqual(['s_two']);
  });

  it('likes move the public counter exactly once per participant, never below zero', async () => {
    expect(await lists.like('p_alice', 's_three')).toEqual({ created: true, likes: 1 });
    expect(await lists.like('p_alice', 's_three')).toEqual({ created: false, likes: 1 });
    expect(await lists.like('p_bob', 's_three')).toEqual({ created: true, likes: 2 });
    expect((await sessions.get('s_three'))?.likes).toBe(2);
    expect(await lists.unlike('p_alice', 's_three')).toEqual({ removed: true, likes: 1 });
    expect(await lists.unlike('p_alice', 's_three')).toEqual({ removed: false, likes: 1 });
    expect((await lists.likedFor('p_bob')).map((s) => s.id)).toEqual(['s_three']);
    expect((await lists.likedFor('p_alice')).map((s) => s.id)).toEqual([]);
  });

  it('history is one row per pair, most recent seat first, and the host role sticks', async () => {
    await lists.visit('p_carol', 's_one', 'guest', 1000);
    await lists.visit('p_carol', 's_two', 'host', 2000);
    await lists.visit('p_carol', 's_one', 'guest', 3000);
    const history = await lists.historyFor('p_carol');
    expect(history.map((h) => [h.session.id, h.role, h.at])).toEqual([
      ['s_one', 'guest', 3000],
      ['s_two', 'host', 2000],
    ]);
    await lists.visit('p_carol', 's_two', 'guest', 4000);
    expect((await lists.historyFor('p_carol'))[0]).toMatchObject({ role: 'host', at: 4000 });
  });

  it('summary carries membership ids and the four counts', async () => {
    const summary = await lists.summary('p_host_a');
    expect(summary.counts.hosted).toBe(2);
    await lists.save('p_host_a', 's_three');
    await lists.like('p_host_a', 's_one');
    await lists.visit('p_host_a', 's_one', 'host');
    expect(await lists.summary('p_host_a')).toEqual({
      savedIds: ['s_three'],
      likedIds: ['s_one'],
      counts: { hosted: 2, history: 1, saved: 1, liked: 1 },
    });
    expect(await lists.summary('p_nobody')).toEqual({
      savedIds: [],
      likedIds: [],
      counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
    });
  });

  it('adopt moves an anonymous participant’s lists onto the account and uncounts duplicate likes', async () => {
    const before = (await sessions.get('s_two'))?.likes ?? 0;
    // Anonymous: saved one + two, liked two, visited one (guest) and two (host).
    await lists.save('p_anon', 's_one', 10);
    await lists.save('p_anon', 's_two', 20);
    await lists.like('p_anon', 's_two');
    await lists.visit('p_anon', 's_one', 'guest', 100);
    await lists.visit('p_anon', 's_two', 'host', 200);
    // The account already saved two, liked two, and visited one earlier.
    await lists.save('p_account', 's_two', 5);
    await lists.like('p_account', 's_two');
    await lists.visit('p_account', 's_one', 'guest', 50);
    expect((await sessions.get('s_two'))?.likes).toBe(before + 2);

    expect(await lists.adopt('p_anon', 'p_account')).toEqual({ saved: 1, liked: 0, history: 2 });
    expect(await lists.adopt('p_anon', 'p_anon')).toEqual({ saved: 0, liked: 0, history: 0 });

    const summary = await lists.summary('p_account');
    expect(summary.savedIds.sort()).toEqual(['s_one', 's_two']);
    expect(summary.likedIds).toEqual(['s_two']);
    expect(summary.counts).toMatchObject({ saved: 2, liked: 1, history: 2 });
    // The duplicate like was uncounted: the public number is one per person.
    expect((await sessions.get('s_two'))?.likes).toBe(before + 1);
    const history = await lists.historyFor('p_account');
    expect(history.map((h) => [h.session.id, h.role, h.at])).toEqual([
      ['s_two', 'host', 200],
      ['s_one', 'guest', 100],
    ]);
    // Nothing is left behind on the anonymous row.
    expect(await lists.summary('p_anon')).toEqual({
      savedIds: [],
      likedIds: [],
      counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
    });
  });
});
