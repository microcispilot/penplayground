import { beforeEach, describe, expect, it } from 'vitest';
import { likesShown, useLists } from '../src/lib/lists.js';
import { testApi } from './harness.js';

const SUMMARY = {
  savedIds: ['s_saved_0001'],
  likedIds: ['s_liked_0001'],
  counts: { hosted: 2, history: 5, saved: 1, liked: 1 },
};

beforeEach(() => useLists.getState().reset());

describe('lists store', () => {
  it('loads a participant’s membership and counts', async () => {
    await useLists.getState().load(testApi({ '/api/me/lists': SUMMARY }), 'p_1');
    const s = useLists.getState();
    expect(s.status).toBe('ready');
    expect(s.savedIds.has('s_saved_0001')).toBe(true);
    expect(s.likedIds.has('s_liked_0001')).toBe(true);
    expect(s.counts).toEqual(SUMMARY.counts);
  });

  it('a failed load leaves the lists empty and says so, instead of pretending', async () => {
    await useLists.getState().load(testApi({}), 'p_1');
    expect(useLists.getState().status).toBe('error');
    expect(useLists.getState().savedIds.size).toBe(0);
  });

  it('a different participant starts from empty, never from the last one’s lists', async () => {
    await useLists.getState().load(testApi({ '/api/me/lists': SUMMARY }), 'p_1');
    expect(useLists.getState().savedIds.size).toBe(1);
    const empty = { savedIds: [], likedIds: [], counts: SUMMARY.counts };
    await useLists.getState().load(testApi({ '/api/me/lists': empty }), 'p_2');
    expect(useLists.getState().participantId).toBe('p_2');
    expect(useLists.getState().savedIds.size).toBe(0);
  });

  it('saving is optimistic and the count follows', async () => {
    const calls: string[] = [];
    const api = testApi(
      { '/api/me/lists': SUMMARY, 'PUT /api/sessions/s_new_00001/save': { saved: true } },
      calls,
    );
    await useLists.getState().load(api, 'p_1');
    const done = useLists.getState().toggleSaved(api, 's_new_00001');
    // The set moved before the request came back.
    expect(useLists.getState().savedIds.has('s_new_00001')).toBe(true);
    expect(useLists.getState().counts.saved).toBe(2);
    await done;
    expect(calls).toContain('PUT /api/sessions/s_new_00001/save');
  });

  it('un-saving removes it, and a refusal puts the row back exactly as it was', async () => {
    const api = testApi({
      '/api/me/lists': SUMMARY,
      'DELETE /api/sessions/s_saved_0001/save': new Error('nope'),
    });
    await useLists.getState().load(api, 'p_1');
    await expect(useLists.getState().toggleSaved(api, 's_saved_0001')).rejects.toThrow();
    expect(useLists.getState().savedIds.has('s_saved_0001')).toBe(true);
    expect(useLists.getState().counts.saved).toBe(1);
  });

  it('liking moves the public count at once and then takes the server’s number', async () => {
    const api = testApi({
      '/api/me/lists': SUMMARY,
      'PUT /api/sessions/s_new_00001/like': { liked: true, likes: 41 },
    });
    await useLists.getState().load(api, 'p_1');
    const done = useLists.getState().toggleLiked(api, 's_new_00001', 12);
    // Optimistic: one more than the card said.
    expect(useLists.getState().likesOf.s_new_00001).toBe(13);
    await done;
    // Authoritative: whatever the server counted, even when it is far from the guess.
    expect(useLists.getState().likesOf.s_new_00001).toBe(41);
    expect(useLists.getState().likedIds.has('s_new_00001')).toBe(true);
  });

  it('a refused like restores the set, the count and the public number together', async () => {
    const api = testApi({
      '/api/me/lists': SUMMARY,
      'DELETE /api/sessions/s_liked_0001/like': new Error('nope'),
    });
    await useLists.getState().load(api, 'p_1');
    await expect(useLists.getState().toggleLiked(api, 's_liked_0001', 7)).rejects.toThrow();
    const s = useLists.getState();
    expect(s.likedIds.has('s_liked_0001')).toBe(true);
    expect(s.counts.liked).toBe(1);
    expect(s.likesOf.s_liked_0001).toBeUndefined();
  });

  it('never counts below zero, however the toggles are pressed', async () => {
    const api = testApi({
      '/api/me/lists': {
        savedIds: [],
        likedIds: ['s_liked_0001'],
        counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
      },
      'DELETE /api/sessions/s_liked_0001/like': { liked: false, likes: 0 },
    });
    await useLists.getState().load(api, 'p_1');
    await useLists.getState().toggleLiked(api, 's_liked_0001', 0);
    expect(useLists.getState().counts.liked).toBe(0);
    expect(useLists.getState().likesOf.s_liked_0001).toBe(0);
  });

  it('likesShown prefers what the client learned over a record fetched earlier', () => {
    expect(likesShown({}, { id: 's_1', likes: 3 })).toBe(3);
    expect(likesShown({ s_1: 9 }, { id: 's_1', likes: 3 })).toBe(9);
    expect(likesShown({ s_1: 0 }, { id: 's_1', likes: 3 })).toBe(0);
  });
});
