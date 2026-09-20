import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Connection,
  connect,
  ListRepository,
  ParticipantRepository,
  type SessionRecord,
  SessionRepository,
} from '../src/index.js';

/**
 * One lesson, told more than once (ADR-0031).
 *
 * Every case here runs on its own database: the catalogue is a whole-table
 * read and a leftover row from another case would be another card.
 */
let conn: Connection;
let sessions: SessionRepository;
let lists: ListRepository;
let participants: ParticipantRepository;

beforeEach(async () => {
  conn = await connect('pglite://memory');
  sessions = new SessionRepository(conn.db);
  lists = new ListRepository(conn.db);
  participants = new ParticipantRepository(conn.db);
});
afterEach(async () => {
  await conn.close();
});

const TRANSFORMERS = 'en.how-transformers-work-in-llms';

function telling(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    topic: 'How Transformers work in LLMs',
    title: 'How Transformers work in LLMs',
    promise: '',
    expertId: 'niko-database-expert',
    hostId: `host-${id}`,
    hostName: 'Learner',
    band: 'beginner',
    domain: 'computing-data',
    visibility: 'public',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 0,
    segments: 3,
    questions: 0,
    recap: ['what we covered'],
    views: 0,
    thumbnail: null,
    canonicalId: TRANSFORMERS,
    language: 'en-US',
    description: '',
    keywords: [],
    likes: 0,
    ...extra,
  };
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('the catalogue shows a lesson once', () => {
  it('collapses every telling of one lesson into a single card', async () => {
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries())
      await sessions.upsert(telling(id, { startedAt: 1_000 + i }));
    // Four session rows, four recordings, four share links — one lesson.
    expect(await sessions.listForHost('host-a')).toHaveLength(1);
    expect(ids(await sessions.listPublic())).toEqual(['a']);
  });

  it('keeps the telling that got furthest, then the most engaged, then the oldest', async () => {
    // Same lesson, told three times. `stopped` never reached a recap however
    // much it was watched; `full` and `busy` both did, and `busy` was watched.
    await sessions.upsert(telling('stopped', { recap: [], views: 99, startedAt: 1 }));
    await sessions.upsert(telling('full', { startedAt: 2 }));
    await sessions.upsert(telling('busy', { views: 5, startedAt: 3 }));
    expect(ids(await sessions.listPublic())).toEqual(['busy']);

    // A longer telling of the same lesson outranks a more watched one: the
    // recording that has more of the lesson in it is the one to keep.
    await sessions.upsert(telling('longer', { durationMs: 60_000, startedAt: 4 }));
    expect(ids(await sessions.listPublic())).toEqual(['longer']);
    await sessions.patch('longer', { durationMs: 0 });

    // A save counts as engagement exactly as a view and a like do, so one save
    // is enough to move the card from `busy` (5 views) to a rival on 6.
    await sessions.upsert(telling('saved', { views: 5, startedAt: 5 }));
    await participants.ensure({ id: 'p_reader', name: 'Sam', plan: 'free', anonymous: true });
    await lists.save('p_reader', 'saved');
    expect(ids(await sessions.listPublic())).toEqual(['saved']);

    // Nothing left to separate them: the oldest telling wins, because its
    // link is the one most likely already shared.
    await sessions.patch('saved', { views: 4 });
    await sessions.patch('longer', { views: 0 });
    expect(ids(await sessions.listPublic())).toEqual(['busy']);
  });

  /**
   * `sessions.segments` is the length of the lesson *plan*, and every telling
   * of one memoised lesson carries the same number. Ranking on it would have
   * kept whichever row happened to sort first while looking principled.
   */
  it('does not rank on the plan’s length, which is the same for every telling', async () => {
    await sessions.upsert(telling('planned-long', { segments: 99, recap: ['a'], startedAt: 1 }));
    await sessions.upsert(telling('got-further', { segments: 1, recap: ['a', 'b'], startedAt: 2 }));
    expect(ids(await sessions.listPublic())).toEqual(['got-further']);
  });

  it('separates lessons that only look alike: another band, language or expert is another card', async () => {
    await sessions.upsert(telling('en-beginner'));
    await sessions.upsert(telling('en-advanced', { band: 'advanced' }));
    await sessions.upsert(telling('fa', { language: 'fa-IR' }));
    await sessions.upsert(telling('other-expert', { expertId: 'juno-javascript-expert' }));
    expect(ids(await sessions.listPublic()).sort()).toEqual([
      'en-advanced',
      'en-beginner',
      'fa',
      'other-expert',
    ]);
  });

  it('never groups sessions that resolved to no canonical topic', async () => {
    // Identical in every visible way, but nothing says they are the same
    // lesson, so nothing collapses them.
    await sessions.upsert(telling('x1', { canonicalId: null }));
    await sessions.upsert(telling('x2', { canonicalId: null }));
    expect(ids(await sessions.listPublic()).sort()).toEqual(['x1', 'x2']);
  });

  it('leaves private and still-running sessions out of the catalogue entirely', async () => {
    await sessions.upsert(telling('live', { endedAt: null, segments: 9 }));
    await sessions.upsert(telling('hidden', { visibility: 'private', segments: 9 }));
    await sessions.upsert(telling('public'));
    expect(ids(await sessions.listPublic())).toEqual(['public']);
  });
});

describe('duplicateGroups', () => {
  it('reports one group per repeated lesson, best first, and says whose it is', async () => {
    await participants.ensure({ id: 'host-kept', name: 'Ada', plan: 'free', anonymous: false });
    await sessions.upsert(telling('kept', { hostId: 'host-kept', segments: 3, startedAt: 1 }));
    await sessions.upsert(telling('spare', { segments: 2, startedAt: 2 }));
    await sessions.upsert(telling('alone', { canonicalId: 'en.swift-fundamentals' }));

    const groups = await sessions.duplicateGroups();
    expect(groups).toHaveLength(1);
    const [group] = groups;
    if (!group) throw new Error('no group');
    expect(group.scopeKey).toBe(`${TRANSFORMERS}|beginner|niko-database-expert|en-US`);
    expect(group.keep.id).toBe('kept');
    // Whose it is, so the script can hold an account's session back.
    expect(group.keep.hostIsAccount).toBe(true);
    expect(ids(group.drop)).toEqual(['spare']);
    expect(group.drop[0]?.hostIsAccount).toBe(false);
  });

  it('says nothing when every lesson was taught once', async () => {
    await sessions.upsert(telling('one'));
    await sessions.upsert(telling('two', { canonicalId: 'en.swift-fundamentals' }));
    expect(await sessions.duplicateGroups()).toEqual([]);
  });

  /**
   * The survivor rule exists twice — in SQL inside `listPublic`, because it has
   * to run inside the query, and in TypeScript inside `rankTellings`, because
   * the deduplicator has to explain itself. This is the case that stops them
   * drifting: the card the catalogue shows and the telling the script keeps
   * have to be the same session, in every tie the rule can reach.
   */
  it('duplicates-and-catalogue-agree: the card shown is the telling that would be kept', async () => {
    await participants.ensure({ id: 'p_reader', name: 'Sam', plan: 'free', anonymous: true });
    const rows: Array<[string, Partial<SessionRecord>]> = [
      ['stopped', { recap: [], views: 99 }],
      ['plain', {}],
      ['tie-views', { views: 3, startedAt: 10 }],
      ['tie-likes', { likes: 3, startedAt: 11 }],
      ['old', { views: 3, startedAt: 5 }],
      ['swift-a', { canonicalId: 'en.swift-fundamentals', startedAt: 7 }],
      ['swift-b', { canonicalId: 'en.swift-fundamentals', startedAt: 8 }],
      ['lonely', { canonicalId: 'en.how-a-bicycle-stays-upright' }],
    ];
    for (const [id, extra] of rows) await sessions.upsert(telling(id, extra));
    await lists.save('p_reader', 'tie-likes');

    const groups = await sessions.duplicateGroups();
    const kept = new Set(groups.map((g) => g.keep.id));
    const dropped = new Set(groups.flatMap((g) => g.drop.map((d) => d.id)));
    const catalogue = new Set(ids(await sessions.listPublic()));

    // Every card is a survivor or a lesson taught once; no dropped telling is
    // ever the card, and no survivor is ever missing from the catalogue.
    for (const id of kept) expect(catalogue.has(id)).toBe(true);
    for (const id of dropped) expect(catalogue.has(id)).toBe(false);
    expect(catalogue.size).toBe(rows.length - dropped.size);
    // `tie-likes` has 3 likes + 1 save = 4 engagement, one ahead of `old` and
    // `tie-views` on 3 views each; among those two the oldest goes first, and
    // the telling that never reached a recap is last however watched.
    expect(kept).toContain('tie-likes');
    expect(kept).toContain('swift-a');
    expect(catalogue.has('lonely')).toBe(true);
    const transformers = groups.find((g) => g.scopeKey.startsWith(TRANSFORMERS));
    expect(ids(transformers?.drop ?? [])).toEqual(['old', 'tie-views', 'plain', 'stopped']);
  });
});

describe('a session that was collapsed into another', () => {
  it('resolves an erased id to the session that was kept, in one hop', async () => {
    await sessions.upsert(telling('kept'));
    await sessions.upsert(telling('gone'));
    await sessions.remove('gone');
    await sessions.redirect('gone', 'kept', 'duplicate');
    expect((await sessions.resolve('gone'))?.id).toBe('kept');
    expect((await sessions.resolve('kept'))?.id).toBe('kept');
    expect(await sessions.resolve('never-existed')).toBeNull();
  });

  it('repoints an old redirect when its target is itself collapsed, never chains', async () => {
    await sessions.upsert(telling('final'));
    await sessions.redirect('a', 'b', 'duplicate');
    await sessions.redirect('b', 'final', 'duplicate');
    expect((await sessions.redirects()).map((r) => [r.fromId, r.toId])).toEqual([
      ['a', 'final'],
      ['b', 'final'],
    ]);
    expect((await sessions.resolve('a'))?.id).toBe('final');
  });

  it('refuses to point an id at itself', async () => {
    await expect(sessions.redirect('x', 'x', 'duplicate')).rejects.toThrow(/itself/);
  });

  it('drops a redirect out of the way when that id comes back as a session', async () => {
    await sessions.upsert(telling('kept'));
    await sessions.redirect('kept', 'other', 'wrong');
    await sessions.redirect('third', 'kept', 'duplicate');
    // `kept` is a session again, so it cannot also be a signpost to `other`.
    expect((await sessions.redirects()).map((r) => r.fromId)).toEqual(['third']);
  });
});

describe('moving a collapsed session’s shelves', () => {
  it('keeps a learner’s save, like and history — pointing at the telling that was kept', async () => {
    await sessions.upsert(telling('kept'));
    await sessions.upsert(telling('gone'));
    await participants.ensure({ id: 'p_one', name: 'Sam', plan: 'free', anonymous: true });
    await participants.ensure({ id: 'p_two', name: 'Ada', plan: 'free', anonymous: true });
    await lists.save('p_one', 'gone');
    await lists.like('p_one', 'gone');
    await lists.visit('p_one', 'gone', 'host', 500);
    // `p_two` already has the survivor liked: the overlap must not double the counter.
    await lists.like('p_two', 'gone');
    await lists.like('p_two', 'kept');

    const moved = await lists.moveSession('gone', 'kept');
    expect(moved).toEqual({ saved: 1, liked: 1, history: 1 });
    expect(ids(await lists.savedFor('p_one'))).toEqual(['kept']);
    expect(ids(await lists.likedFor('p_one'))).toEqual(['kept']);
    expect((await lists.historyFor('p_one')).map((h) => h.session.id)).toEqual(['kept']);
    // Two people like the survivor, and the counter says two, not three.
    expect((await sessions.get('kept'))?.likes).toBe(2);
    expect((await sessions.get('gone'))?.likes).toBe(0);
  });

  it('erases the shelves of a session that is going nowhere', async () => {
    await sessions.upsert(telling('gone'));
    await participants.ensure({ id: 'p_one', name: 'Sam', plan: 'free', anonymous: true });
    await lists.save('p_one', 'gone');
    await lists.like('p_one', 'gone');
    await lists.visit('p_one', 'gone', 'host', 500);
    expect(await lists.forgetSession('gone')).toBe(3);
    expect(await lists.forgetSession('gone')).toBe(0);
    expect(await lists.summary('p_one')).toMatchObject({
      savedIds: [],
      likedIds: [],
      counts: { history: 0, saved: 0, liked: 0 },
    });
  });
});
