import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommentRepository,
  type Connection,
  connect,
  ParticipantRepository,
  SessionRepository,
} from '../src/index.js';

/**
 * Comments under a session (ADR-0044), at the table.
 *
 * Three things the page relies on and would not notice were wrong until a
 * reader did: the thread is newest first and a page cut by `before` never
 * repeats or skips; a deletion is soft and leaves counts and later pages
 * honest; and the author's name and picture are the participant's *now*,
 * not a copy taken when the comment was written.
 */
let conn: Connection;
let comments: CommentRepository;
let participants: ParticipantRepository;
let sessions: SessionRepository;

beforeAll(async () => {
  conn = await connect('pglite://memory');
  comments = new CommentRepository(conn.db);
  participants = new ParticipantRepository(conn.db);
  sessions = new SessionRepository(conn.db);
  await participants.ensure({ id: 'p_ada', name: 'Ada', plan: 'free', anonymous: false });
  await participants.ensure({ id: 'p_lin', name: 'Lin', plan: 'standard', anonymous: false });
  await sessions.upsert({
    id: 's_thread',
    topic: 'Swift',
    title: 'Swift fundamentals',
    promise: '',
    expertId: 'juno',
    hostId: 'p_ada',
    hostName: 'Ada',
    band: 'beginner',
    domain: 'computing-data',
    visibility: 'public',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
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

describe('a thread', () => {
  it('reads newest first, with the author as they are now', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await comments.create({
        id: `c_${i}`,
        sessionId: 's_thread',
        authorId: i % 2 ? 'p_ada' : 'p_lin',
        body: `comment ${i}`,
        now: 10_000 + i,
      });
    }
    const page = await comments.list('s_thread');
    expect(page.total).toBe(5);
    expect(page.comments.map((c) => c.id)).toEqual(['c_5', 'c_4', 'c_3', 'c_2', 'c_1']);
    expect(page.comments[0]).toMatchObject({
      authorId: 'p_ada',
      authorName: 'Ada',
      authorAvatarUrl: null,
      body: 'comment 5',
      createdAt: 10_005,
    });
    // A rename follows: the name is read at listing time, never copied.
    await participants.rename('p_ada', 'Ada Lovelace');
    const again = await comments.list('s_thread');
    expect(again.comments[0]?.authorName).toBe('Ada Lovelace');
  });

  it('pages by `before` without repeating or skipping', async () => {
    const first = await comments.list('s_thread', { limit: 2 });
    expect(first.comments.map((c) => c.id)).toEqual(['c_5', 'c_4']);
    const last = first.comments.at(-1);
    const second = await comments.list('s_thread', { limit: 2, before: last?.createdAt ?? 0 });
    expect(second.comments.map((c) => c.id)).toEqual(['c_3', 'c_2']);
    const third = await comments.list('s_thread', {
      limit: 2,
      before: second.comments.at(-1)?.createdAt ?? 0,
    });
    expect(third.comments.map((c) => c.id)).toEqual(['c_1']);
    expect(third.total).toBe(5);
  });

  it('deletes softly: gone from the thread and the count, still a row', async () => {
    expect(await comments.remove('c_3')).toBe(true);
    // A second deletion is not a deletion.
    expect(await comments.remove('c_3')).toBe(false);
    const page = await comments.list('s_thread');
    expect(page.total).toBe(4);
    expect(page.comments.map((c) => c.id)).toEqual(['c_5', 'c_4', 'c_2', 'c_1']);
    expect(await comments.get('c_3')).toBeNull();
    // The row is kept, marked, for the count arithmetic and for a report.
    const row = await comments.row('c_3');
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.body).toBe('comment 3');
    expect(await comments.count('s_thread')).toBe(4);
  });

  it('goes with the session when the session is erased', async () => {
    expect(await comments.forgetSession('s_thread')).toBe(5);
    expect(await comments.count('s_thread')).toBe(0);
    expect(await comments.row('c_1')).toBeNull();
  });
});
