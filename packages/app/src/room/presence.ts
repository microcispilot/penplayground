import type { Participant, RoomState } from '@pen/contracts';
import type { ExpertPresence } from '@pen/design';
import type { RoomAudioUi } from './audio/RoomAudio.js';

/**
 * Who is making a sound, and who merely has the room's attention.
 *
 * The distinction matters: the panel animates a ring only for someone who is
 * actually producing audio right now, and draws a still ring for whoever holds
 * the floor. Every value below comes from state the room already broadcasts —
 * `RoomState.floor`, the media server's active speakers, and this device's own
 * microphone level — so nothing on screen is a decoration over a silent person.
 */
export type ParticipantPresence =
  | 'speaking' // audible right now (media server, or this device's own RMS)
  | 'floor' // has the room's attention; not necessarily making a sound
  | 'muted' // on voice, muted
  | 'listening' // on voice, quiet
  | 'quiet'; // no voice channel in this session

/**
 * Above this RMS the local microphone is carrying a voice rather than a room.
 * The bottom bar's own level ring fades in over the same range
 * (`min(1, micLevel * 12)`), so the two agree about when someone is talking.
 */
export const SELF_SPEAKING_RMS = 0.02;

/** The modes in which somebody other than the expert holds the room. */
function floorIsHeld(state: RoomState): boolean {
  return state.mode === 'listening' || state.mode === 'thinking' || state.mode === 'answering';
}

export interface ParticipantPresenceInput {
  participant: Participant;
  selfId: string;
  state: RoomState;
  /** Null in solo sessions (no voice between participants). */
  audio: RoomAudioUi | null;
  /** This device's microphone, for the row that is us. */
  micState: 'idle' | 'starting' | 'listening' | 'denied' | 'error';
  micLevel: number;
}

export function participantPresence(input: ParticipantPresenceInput): ParticipantPresence {
  const { participant: p, selfId, state, audio, micState, micLevel } = input;
  const isSelf = p.id === selfId;
  const voiceOn = audio !== null && audio.status !== 'off';
  const holdsFloor = state.floor === p.id && floorIsHeld(state);

  if (voiceOn && audio.speaking.includes(p.id)) return 'speaking';
  // Solo sessions have no media server to report speech, so the only honest
  // signal for ourselves is the level the microphone is actually measuring.
  if (isSelf && micState === 'listening' && micLevel > SELF_SPEAKING_RMS) {
    const mutedHere = voiceOn && audio.mutedByHost;
    if (!mutedHere) return 'speaking';
  }
  if (holdsFloor) return 'floor';
  if (!voiceOn) return 'quiet';
  if (isSelf) {
    if (audio.status !== 'connected') return 'quiet';
    return audio.mutedByHost ? 'muted' : 'listening';
  }
  const remote = audio.participants[p.id];
  if (!remote) return 'quiet';
  return remote.muted ? 'muted' : 'listening';
}

/** The one-word state under a participant's name. */
export function presenceLabel(presence: ParticipantPresence, isHost: boolean): string {
  switch (presence) {
    case 'speaking':
      return 'Speaking';
    case 'floor':
      return 'Has the floor';
    case 'muted':
      return 'Muted';
    case 'listening':
      return 'On voice';
    default:
      return isHost ? 'Hosting' : 'Listening';
  }
}

/**
 * The AI human's own presence, in the orb's vocabulary. Lifted out of the room
 * screen so the panel, the board and the tests all read one rule.
 */
export function expertPresence(state: RoomState | null, speaking: boolean): ExpertPresence {
  if (!state || state.phase !== 'live') return 'idle';
  if (state.mode === 'listening') return 'listening';
  if (state.mode === 'thinking') return 'thinking';
  if (state.mode === 'paused' || state.mode === 'discussing') return 'paused';
  return speaking ? 'speaking' : 'idle';
}

/** "Ada · listening" — what the panel writes under the orb. */
export function expertPresenceLabel(presence: ExpertPresence): string {
  switch (presence) {
    case 'speaking':
      return 'Speaking';
    case 'listening':
      return 'Listening';
    case 'thinking':
      return 'Thinking';
    case 'paused':
      return 'Paused';
    default:
      return 'With you';
  }
}
