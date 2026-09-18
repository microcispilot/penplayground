import { EMPTY_LIST_SUMMARY, type ListSummary } from '@pen/contracts';
import { create } from 'zustand';
import type { ApiClient } from '../api/client.js';
import { track } from './analytics.js';

/**
 * The learner's lists (ADR-0015), kept client-side as sets so every card can
 * paint its heart and bookmark without a request. Toggles are optimistic:
 * the set and the counts move at once and are put back if the server says no.
 * Public like counts the client has learned (`likesOf`) override the stale
 * number on a record that was fetched before the toggle.
 */
interface ListsState {
  /** Which participant these lists belong to; a different id means reload. */
  participantId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  savedIds: ReadonlySet<string>;
  likedIds: ReadonlySet<string>;
  counts: ListSummary['counts'];
  /** Like counts learned from toggles, by session id. */
  likesOf: Readonly<Record<string, number>>;
  load(api: ApiClient, participantId: string): Promise<void>;
  /** Flip; resolves to the state that stuck, or throws with the previous state restored. */
  toggleSaved(api: ApiClient, sessionId: string): Promise<boolean>;
  toggleLiked(api: ApiClient, sessionId: string, knownLikes: number): Promise<boolean>;
  reset(): void;
}

const EMPTY: Pick<ListsState, 'savedIds' | 'likedIds' | 'counts' | 'likesOf'> = {
  savedIds: new Set(),
  likedIds: new Set(),
  counts: EMPTY_LIST_SUMMARY.counts,
  likesOf: {},
};

function withMember(set: ReadonlySet<string>, id: string, member: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (member) next.add(id);
  else next.delete(id);
  return next;
}

export const useLists = create<ListsState>((set, get) => ({
  participantId: null,
  status: 'idle',
  ...EMPTY,

  async load(api, participantId) {
    if (get().participantId !== participantId) set({ participantId, status: 'loading', ...EMPTY });
    else set({ status: 'loading' });
    try {
      const summary = await api.listSummary();
      // The participant changed while loading: this summary is someone else's.
      if (get().participantId !== participantId) return;
      set({
        status: 'ready',
        savedIds: new Set(summary.savedIds),
        likedIds: new Set(summary.likedIds),
        counts: summary.counts,
      });
    } catch {
      if (get().participantId === participantId) set({ status: 'error' });
    }
  },

  async toggleSaved(api, sessionId) {
    const before = get();
    const next = !before.savedIds.has(sessionId);
    set({
      savedIds: withMember(before.savedIds, sessionId, next),
      counts: { ...before.counts, saved: Math.max(0, before.counts.saved + (next ? 1 : -1)) },
    });
    try {
      const result = await api.setSaved(sessionId, next);
      track(next ? 'session_saved' : 'session_unsaved');
      return result.saved;
    } catch (error) {
      set({ savedIds: before.savedIds, counts: before.counts });
      throw error;
    }
  },

  async toggleLiked(api, sessionId, knownLikes) {
    const before = get();
    const next = !before.likedIds.has(sessionId);
    const shown = before.likesOf[sessionId] ?? knownLikes;
    set({
      likedIds: withMember(before.likedIds, sessionId, next),
      counts: { ...before.counts, liked: Math.max(0, before.counts.liked + (next ? 1 : -1)) },
      likesOf: { ...before.likesOf, [sessionId]: Math.max(0, shown + (next ? 1 : -1)) },
    });
    try {
      const result = await api.setLiked(sessionId, next);
      set((s) => ({ likesOf: { ...s.likesOf, [sessionId]: result.likes } }));
      track(next ? 'session_liked' : 'session_unliked');
      return result.liked;
    } catch (error) {
      set({ likedIds: before.likedIds, counts: before.counts, likesOf: before.likesOf });
      throw error;
    }
  },

  reset() {
    set({ participantId: null, status: 'idle', ...EMPTY });
  },
}));

/** The like count to show for a record: what the client learned, else what the record says. */
export function likesShown(
  likesOf: Readonly<Record<string, number>>,
  session: { id: string; likes: number },
): number {
  return likesOf[session.id] ?? session.likes;
}
