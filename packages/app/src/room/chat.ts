/**
 * The room's chat: what the **people** in the room say to each other.
 *
 * The expert is not in it. Not "filtered out of it" — never in it. The room
 * broadcasts a chat line, rate-limits it and refuses it behind an ad, and
 * nothing else in the session reads it: no floor, no plan, no pipeline, no
 * model, no cost (`ServerChat` in `packages/contracts/src/wire.ts`,
 * `SessionRoom.chat()` in `packages/session-engine/src/room.ts`, and the
 * absences pinned by `packages/session-engine/test/chat.test.ts`).
 *
 * A real expert teaching a room does not read the side conversation and does
 * not stop teaching because somebody typed. Asking *them* something is
 * speaking — which is why there is no typed route to the expert any more.
 *
 * Pure on purpose: `RoomSession` owns the socket, this owns the list, and the
 * list is what the tests can reason about.
 */

/** One line somebody said to the room, as the room stamped it. */
export interface ChatLine {
  /** Unique per arrival: `<participantId>@<at>#<n>`, so two identical lines are two rows. */
  id: string;
  participantId: string;
  /**
   * The sender's name at the moment they sent it. It travels with the line
   * rather than being looked up: a participant can leave, and what they said
   * stays said.
   */
  name: string;
  text: string;
  /** Server wall clock, ms since epoch — one order for every client. */
  at: number;
  /** This device's own line. */
  own: boolean;
}

/**
 * How many lines the room keeps. A side conversation is not a document: past
 * this the earliest lines are dropped rather than growing a list nobody
 * scrolls back to. Chat is never saved with the session, so nothing is lost
 * that was ever kept.
 */
export const CHAT_LIMIT = 200;

/**
 * How long a gap breaks a run of lines from one person. Under it, a second
 * line joins the first under the same name; over it, the name and the time
 * are worth repeating because the moment has moved on. Five minutes is the
 * grouping window Slack and Meet settled on, and a lesson is short enough
 * that most runs never reach it.
 */
export const CHAT_GROUP_GAP_MS = 5 * 60_000;

/** Add one line, oldest first out. */
export function appendChat(list: readonly ChatLine[], line: ChatLine): ChatLine[] {
  const next = [...list, line];
  return next.length <= CHAT_LIMIT ? next : next.slice(next.length - CHAT_LIMIT);
}

/**
 * A run of consecutive lines from one person, shown under one name and one
 * quiet timestamp — the shape every chat between people has converged on.
 */
export interface ChatGroup {
  /** The id of the run's first line, so React keys a run by the line it began with. */
  id: string;
  participantId: string;
  name: string;
  own: boolean;
  /** When the run started. */
  at: number;
  lines: ChatLine[];
}

/**
 * Group consecutive lines from the same participant.
 *
 * A run is broken by a different sender or by a gap wider than
 * `CHAT_GROUP_GAP_MS` — never by the name, because two people may share one
 * (the roster tells them apart by face and position; chat tells them apart by
 * id, which is the thing that is actually unique).
 */
export function groupChat(
  list: readonly ChatLine[],
  gapMs: number = CHAT_GROUP_GAP_MS,
): ChatGroup[] {
  const groups: ChatGroup[] = [];
  for (const line of list) {
    const open = groups[groups.length - 1];
    const last = open?.lines[open.lines.length - 1];
    if (open && last && open.participantId === line.participantId && line.at - last.at <= gapMs) {
      open.lines.push(line);
      continue;
    }
    groups.push({
      id: line.id,
      participantId: line.participantId,
      // The name a run is headed with is the one its first line carried.
      name: line.name,
      own: line.own,
      at: line.at,
      lines: [line],
    });
  }
  return groups;
}
