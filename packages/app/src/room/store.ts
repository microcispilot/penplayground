import type { ConductorPhase } from '@pen/conductor';
import type { CheckEvent, Expert, PreparationProgress, RoomState } from '@pen/contracts';
import { create } from 'zustand';
import type { RoomConnectionStatus } from './RoomClient.js';

export interface CaptionLine {
  who: 'expert' | 'learner';
  speaker: string;
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
  ad: { adId: string; durationMs: number; skippableAfterMs: number; startedAt: number } | null;
  notice: { text: string; tone: 'neutral' | 'danger' } | null;
  preparation: PreparationProgress | null;
  micState: 'idle' | 'starting' | 'listening' | 'denied' | 'error';
  micLevel: number;
  captionsOn: boolean;
  learnerHeard: string;
  /** Wall-clock derived lesson clock for the bottom bar. */
  clockMs: number;
  errorText: string | null;
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
  preparation: null,
  micState: 'idle',
  micLevel: 0,
  captionsOn: true,
  learnerHeard: '',
  clockMs: 0,
  errorText: null,
};

export const useRoomStore = create<RoomUiState & RoomUiActions>((set) => ({
  ...initial,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));
