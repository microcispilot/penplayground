import type { ConductorPhase } from '@pen/conductor';
import type {
  AdSlot,
  CheckEvent,
  Expert,
  NoteEvent,
  PreparationProgress,
  RoomState,
} from '@pen/contracts';
import { create } from 'zustand';
import type { RoomAudioUi } from './audio/RoomAudio.js';
import type { ChatLine } from './chat.js';
import type { RoomConnectionStatus } from './RoomClient.js';
import type { LiveReaction } from './reactions.js';

/**
 * One subtitle over the board. `who` drives the reveal (the expert's line is
 * typed out in time with their voice, the learner's appears at once), not a
 * label: a caption carries the words and no name.
 */
export interface CaptionLine {
  who: 'expert' | 'learner';
  text: string;
  /** ms to reveal the whole line (expert) */
  revealMs: number;
  live: boolean;
  at: number;
}

export interface RoomUiState {
  connection: RoomConnectionStatus;
  state: RoomState | null;
  expert: Expert | null;
  phase: ConductorPhase;
  speaking: boolean;
  caption: CaptionLine | null;
  hint: string | null;
  check: CheckEvent | null;
  /** The ad the conductor is holding the lesson for, with the tag the player requests (ADR-0014). */
  ad: {
    adId: string;
    durationMs: number;
    skippableAfterMs: number;
    startedAt: number;
    tagUrl: string;
    slot: AdSlot;
  } | null;
  notice: { text: string; tone: 'neutral' | 'danger' } | null;
  /** The room asked for the way forward to be shown (ADR-0040): a question on a plan without answers. */
  nudge: 'questions' | null;
  /**
   * The conductor saw the room go quiet with speech still owed: the learner is
   * owed an honest line rather than stillness (docs/PRODUCT.md).
   */
  waiting: boolean;
  /**
   * The browser is holding the expert's voice until this page is touched.
   * A first-class state, not a warning: one calm control resumes it.
   */
  soundBlocked: boolean;
  preparation: PreparationProgress | null;
  micState: 'idle' | 'starting' | 'listening' | 'denied' | 'error';
  micLevel: number;
  /**
   * Subtitles over the board. **Off until the learner asks for them** (the CC
   * control in the bottom bar): a real expert does not write their own
   * transcript on the board, and the words are there for whoever wants them
   * rather than for everyone by default.
   */
  captionsOn: boolean;
  /**
   * What the *people* in the room have said to each other (`chat.ts`). The
   * expert is not in this list and never sees it; nothing here interrupts the
   * lesson.
   */
  chat: ChatLine[];
  /**
   * Reactions still on screen (`room/reactions.ts`): expression from the
   * people in the room that never takes the floor from the expert.
   */
  reactions: LiveReaction[];
  learnerHeard: string;
  /** This guest's hand is up (ADR-0037); the room's queue is `state.hands`. */
  handRaised: boolean;
  /** Pinned "You asked" notes, in order. */
  notes: NoteEvent[];
  /** Wall-clock derived lesson clock for the bottom bar. */
  clockMs: number;
  errorText: string | null;
  /** Human-to-human audio (LiveKit): presence, speaking, mute state. `status: 'off'` in solo sessions. */
  audio: RoomAudioUi;
}

export interface RoomUiActions {
  set: (patch: Partial<RoomUiState>) => void;
  reset: () => void;
}

const initial: RoomUiState = {
  connection: 'closed',
  state: null,
  expert: null,
  phase: 'idle',
  speaking: false,
  caption: null,
  hint: null,
  check: null,
  ad: null,
  notice: null,
  nudge: null,
  waiting: false,
  soundBlocked: false,
  preparation: null,
  micState: 'idle',
  micLevel: 0,
  captionsOn: false,
  chat: [],
  reactions: [],
  learnerHeard: '',
  handRaised: false,
  notes: [],
  clockMs: 0,
  errorText: null,
  audio: {
    status: 'off',
    participants: {},
    speaking: [],
    mutedByHost: false,
    playbackBlocked: false,
  },
};

export const useRoomStore = create<RoomUiState & RoomUiActions>((set) => ({
  ...initial,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));

declare global {
  interface Window {
    /**
     * Debug handle for devtools and the screenshot sweep, alongside
     * `window.__penAudioRoom`: it reads what the room is showing and can put a
     * roster in front of the panel that would otherwise need twelve browsers.
     * Read-only as far as the product is concerned — nothing in the app uses it.
     */
    __penRoomStore?: typeof useRoomStore;
  }
}

if (typeof window !== 'undefined') window.__penRoomStore = useRoomStore;
