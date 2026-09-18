import { describe, expect, it } from 'vitest';
import { EMPTY_LIST_SUMMARY, LikeResult, ListSummary, SaveResult, Visit } from '../src/index.js';

describe('lists contracts', () => {
  it('ListSummary carries membership ids and four non-negative counts', () => {
    expect(ListSummary.parse(EMPTY_LIST_SUMMARY)).toEqual(EMPTY_LIST_SUMMARY);
    const parsed = ListSummary.parse({
      savedIds: ['s_abcdefgh'],
      likedIds: [],
      counts: { hosted: 2, history: 3, saved: 1, liked: 0 },
    });
    expect(parsed.savedIds).toEqual(['s_abcdefgh']);
    expect(() =>
      ListSummary.parse({ savedIds: [], likedIds: [], counts: { hosted: -1 } }),
    ).toThrow();
    // Session ids are server-minted: a short junk id never reaches the client's sets.
    expect(() => ListSummary.parse({ ...EMPTY_LIST_SUMMARY, savedIds: ['x'] })).toThrow();
  });

  it('toggle results are exactly what the optimistic client reconciles against', () => {
    expect(SaveResult.parse({ saved: true })).toEqual({ saved: true });
    expect(LikeResult.parse({ liked: false, likes: 0 })).toEqual({ liked: false, likes: 0 });
    expect(() => LikeResult.parse({ liked: true })).toThrow();
    expect(() => LikeResult.parse({ liked: true, likes: -1 })).toThrow();
  });

  it('a visit is a role and a time', () => {
    expect(Visit.parse({ role: 'guest', at: 1 })).toEqual({ role: 'guest', at: 1 });
    expect(() => Visit.parse({ role: 'viewer', at: 1 })).toThrow();
  });
});
