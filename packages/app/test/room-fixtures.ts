import type { Expert, Participant, RoomState } from '@pen/contracts';
import type { RoomAudioUi } from '../src/room/audio/RoomAudio.js';

export const HOST_ID = 'p_host_000001';

export function participant(n: number, over: Partial<Participant> = {}): Participant {
  return {
    id: n === 0 ? HOST_ID : `p_guest_${String(n).padStart(6, '0')}`,
    name: n === 0 ? 'Ada Lovelace' : `Guest ${n}`,
    role: n === 0 ? 'host' : 'guest',
    hue: (n * 37) % 360,
    micOn: false,
    joinedAt: 1_700_000_000_000 + n,
    ...over,
  };
}

/** A room with `people` participants; the first is the host and "you". */
export function roomState(people: number, over: Partial<RoomState> = {}): RoomState {
  return {
    sessionId: 's_test_0001',
    topic: 'How Transformers work in LLMs',
    language: 'en',
    expertId: 'ada-ml-expert',
    phase: 'live',
    mode: 'teaching',
    floor: null,
    hostId: HOST_ID,
    participants: Array.from({ length: people }, (_, i) => participant(i)),
    plan: {
      title: 'How Transformers work',
      promise: 'Read an attention diagram without flinching.',
      band: 'intermediate',
      segments: [
        { index: 0, title: 'Attention', goal: 'weighted average', seconds: 300, hasCheck: true },
      ],
      seconds: 300,
    },
    segment: 0,
    clockMs: 12_000,
    pace: 1,
    preparation: null,
    evidenceTier: 'reviewed_pack_source',
    startedAt: 1_700_000_000_000,
    recap: null,
    resume: null,
    ...over,
  };
}

export const EXPERT: Expert = {
  id: 'ada-ml-expert',
  displayName: 'Ada Lovelace',
  role: 'Machine learning teacher',
} as unknown as Expert;

export function audioUi(over: Partial<RoomAudioUi> = {}): RoomAudioUi {
  return {
    status: 'connected',
    participants: {},
    speaking: [],
    mutedByHost: false,
    playbackBlocked: false,
    ...over,
  };
}
