import { z } from 'zod';
import { DownstreamAudioHeader } from './audio-frame.js';
import { Cue } from './cues.js';
import { ParticipantId } from './ids.js';
import { Pace } from './pace.js';

/**
 * Recording ledger: everything needed to replay a session deterministically.
 * Audio payloads are stored separately (object storage) and referenced by
 * `audioRef`; the ledger itself stays small.
 */
export const LedgerEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cue'), t: z.number().int(), cue: Cue }),
  z.object({
    kind: z.literal('audio'),
    t: z.number().int(),
    header: DownstreamAudioHeader,
    audioRef: z.string(),
  }),
  z.object({
    kind: z.literal('caption'),
    t: z.number().int(),
    participantId: ParticipantId,
    text: z.string(),
  }),
  z.object({
    kind: z.literal('mode'),
    t: z.number().int(),
    mode: z.string(),
    floor: ParticipantId.nullable(),
  }),
  z.object({
    kind: z.literal('interrupt'),
    t: z.number().int(),
    participantId: ParticipantId,
    atSeq: z.number().int(),
    offsetMs: z.number().int(),
  }),
  z.object({
    kind: z.literal('join'),
    t: z.number().int(),
    participantId: ParticipantId,
    name: z.string(),
  }),
  z.object({ kind: z.literal('leave'), t: z.number().int(), participantId: ParticipantId }),
  /** The host changed the teaching pace; replay knows the pace at every moment from these. */
  z.object({
    kind: z.literal('pace'),
    t: z.number().int(),
    pace: Pace,
    participantId: ParticipantId,
  }),
]);
export type LedgerEntry = z.infer<typeof LedgerEntry>;
