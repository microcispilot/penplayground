/**
 * The room's conversation: everything that was said, in the order it was said,
 * so the learner can read back rather than catch a caption before it goes.
 *
 * Structure taken from Simurgh's desktop conversation (one `article` per
 * message, a small uppercase speaker label above the line, the learner's
 * in-progress speech as a live caption that resolves into a final message);
 * the words, the state and the vocabulary are Pen's.
 *
 * Pure on purpose: `RoomSession` owns the sockets, this owns the list, and the
 * list is what the tests can reason about.
 */

export type ConversationRole = 'expert' | 'learner' | 'system';

/**
 * What a line *is*, beyond who said it. The panel shows them all the same way
 * except the system line; the kind is what the tests and the ledger read.
 */
export type ConversationKind =
  | 'lesson' // a sentence of the lesson itself
  | 'answer' // the expert answering a question or grading a check
  | 'question' // the learner's question, spoken or typed
  | 'check' // the learner's answer to a check-in
  | 'system'; // the room speaking about itself: an ad, a reconnection, the end

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  /** The small label above the line: the expert's first name, or "You". */
  speaker: string;
  text: string;
  /** Still being transcribed: rendered as the dashed, italic in-progress line. */
  live: boolean;
  /** Wall clock at the moment the line was shown. */
  at: number;
  kind: ConversationKind;
}

/**
 * How many messages the room keeps. A 40-minute lesson is a few hundred
 * sentences; past this the earliest ones are dropped rather than growing a
 * list nobody scrolls back to (the saved session keeps the whole transcript).
 */
export const CONVERSATION_LIMIT = 400;

function bounded(list: readonly ConversationMessage[]): ConversationMessage[] {
  return list.length <= CONVERSATION_LIMIT
    ? [...list]
    : list.slice(list.length - CONVERSATION_LIMIT);
}

/** Append one finished line. */
export function appendMessage(
  list: readonly ConversationMessage[],
  message: ConversationMessage,
): ConversationMessage[] {
  return bounded([...list, message]);
}

/**
 * What the learner is saying right now.
 *
 * A partial transcript replaces the live line rather than adding to it, and
 * the final one resolves that same line in place — so a spoken question leaves
 * exactly one message behind, the way it would if it had been typed.
 */
export function learnerSaid(
  list: readonly ConversationMessage[],
  line: { id: string; speaker: string; text: string; final: boolean; at: number },
): ConversationMessage[] {
  const last = list[list.length - 1];
  if (last && last.role === 'learner' && last.live) {
    const resolved: ConversationMessage = {
      ...last,
      speaker: line.speaker,
      text: line.text,
      live: !line.final,
      at: line.at,
    };
    return [...list.slice(0, -1), resolved];
  }
  return appendMessage(list, {
    id: line.id,
    role: 'learner',
    speaker: line.speaker,
    text: line.text,
    live: !line.final,
    at: line.at,
    kind: 'question',
  });
}

/**
 * A line the room says about itself. Deduped against the line before it: a
 * socket that flaps must not write "Reconnecting…" into the conversation five
 * times.
 */
export function systemSaid(
  list: readonly ConversationMessage[],
  line: { id: string; text: string; at: number },
): ConversationMessage[] {
  const last = list[list.length - 1];
  if (last && last.role === 'system' && last.text === line.text) return [...list];
  return appendMessage(list, {
    id: line.id,
    role: 'system',
    speaker: '',
    text: line.text,
    live: false,
    at: line.at,
    kind: 'system',
  });
}

/**
 * The expert's own words. A sentence of the lesson and a sentence of an answer
 * look the same to the learner and read the same in the panel; the thread is
 * kept so the transcript can tell them apart.
 */
export function expertSaid(
  list: readonly ConversationMessage[],
  line: { id: string; speaker: string; text: string; at: number; thread: string },
): ConversationMessage[] {
  return appendMessage(list, {
    id: line.id,
    role: 'expert',
    speaker: line.speaker,
    text: line.text,
    live: false,
    at: line.at,
    kind: line.thread === 'lesson' ? 'lesson' : 'answer',
  });
}
