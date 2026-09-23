import type { Expert, Participant, RoomState } from '@pen/contracts';
import { Avatar, Button, cn, ExpertOrb, type ExpertPresence, Pill } from '@pen/design';
import { ChevronDown, Hand, Mic, MicOff, UserMinus, VolumeX } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { RoomAudioUi } from '../room/audio/RoomAudio.js';
import {
  expertPresenceLabel,
  type ParticipantPresence,
  participantPresence,
  presenceLabel,
} from '../room/presence.js';
import type { LiveReaction } from '../room/reactions.js';
import { ReactionPills } from './Reactions.js';

/** The media server's view of one voice: what `data-voice` reports and the popover lists. */
export type VoiceState = 'speaking' | 'muted' | 'on' | 'off';

export function voiceOf(p: Participant, selfId: string, audio: RoomAudioUi | null): VoiceState {
  if (!audio || audio.status === 'off') return 'off';
  if (p.id === selfId) {
    if (audio.status !== 'connected') return 'off';
    if (audio.mutedByHost) return 'muted';
    return audio.speaking.includes(p.id) ? 'speaking' : 'on';
  }
  const remote = audio.participants[p.id];
  if (!remote) return 'off';
  if (remote.muted) return 'muted';
  return audio.speaking.includes(p.id) ? 'speaking' : 'on';
}

const VOICE_LABEL: Record<VoiceState, string> = {
  speaking: 'Speaking',
  muted: 'Muted',
  on: 'On voice',
  off: 'Not on voice',
};

/** An avatar with the voice state drawn on it: a presence ring while speaking, a mic-off badge when muted. */
export function VoiceAvatar({
  p,
  voice,
  size,
}: {
  p: Participant;
  voice: VoiceState;
  size: number;
}) {
  return (
    <span className="relative inline-grid shrink-0" data-voice={voice} data-participant={p.id}>
      <Avatar
        name={p.name}
        hue={p.hue}
        size={size}
        ring
        className={cn(
          'transition-shadow duration-[var(--duration-fast)]',
          voice === 'speaking' &&
            'shadow-[0_0_0_2px_var(--color-surface-container-low),0_0_0_4px_var(--color-presence)]',
          voice === 'muted' && 'opacity-70',
        )}
      />
      {voice === 'muted' ? (
        /* Quiet, not alarming: being muted is an ordinary state of a call, and
           the row beside this says the word as well. */
        <span
          className="absolute -end-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-surface-container-highest text-on-surface-variant ring-2 ring-surface-container-low"
          aria-hidden
        >
          <MicOff size={8} />
        </span>
      ) : null}
    </span>
  );
}

// ── the panel's roster ────────────────────────────────────────────────────────

/**
 * Everyone on the call, the AI human first.
 *
 * Built the way Meet, Zoom and Teams build a tile, because a room with one AI
 * expert and a handful of people is a call and people already know how to
 * read one:
 *
 *   The tile is the frame and the name is *in* it — bottom-left, small, over
 *   a scrim of the tile's own colour rather than in a bordered, blurred pill
 *   floating on top of it. The scrim does real work: the face is centred in
 *   the whole tile, so at one or two people it passes behind the name.
 *
 *   The name is a name. "Amara Diallo (AI expert)" and "Learner (You)" are
 *   not how anyone labels a participant; a meeting app writes the name, and
 *   beside it, in a quieter weight, the one word that matters — and your own
 *   tile simply says **You**, which is what Meet has done for a decade.
 *
 *   Nothing is drawn in a corner that you cannot press. The old tiles carried
 *   a bright green circle on every face at all times to report a state the
 *   mic glyph beside the name already reports. The corner now holds a control
 *   only when there is something to do there: unblock the expert's voice,
 *   toggle your own microphone, mute a guest as the host.
 *
 * The layout still follows the count, the way a call grid does: one card is
 * given room, three are compact, and past three only three are shown with an
 * overflow control — the avatar-stack-with-overflow pattern Google Meet,
 * Figma and Linear all settled on, because a roster that grows without bound
 * pushes the conversation off the screen.
 *
 * Whoever is audible right now is ringed in presence green — the same green
 * the media server's "speaking" paints on every other face in the product —
 * and whoever merely holds the floor gets a quiet outline. Both come from
 * state the room broadcasts (`floor`, the media server's active speakers,
 * this device's own microphone level), so a silent participant is never
 * animated, and no ordinary state is ever drawn in an alarm colour.
 */
export interface ParticipantRosterProps {
  state: RoomState;
  expert: Expert | null;
  /** The AI human's own presence, from the conductor. */
  expertPresence: ExpertPresence;
  expertPortraitUrl: string | null;
  /** The browser is holding the expert's voice; the card's speaker button clears it. */
  soundBlocked: boolean;
  onEnableSound: () => void;
  isHost: boolean;
  selfId: string;
  audio: RoomAudioUi | null;
  micState: 'idle' | 'starting' | 'listening' | 'denied' | 'error';
  micLevel: number;
  onToggleMic: () => void;
  /** Host only; `undefined` mutes everyone but the host. */
  onMute: ((participantId?: string) => void) | null;
  /** Host only: take a guest out of the room for good (ADR-0037). */
  onRemove?: ((participantId: string) => void) | null;
  /** Reactions still on screen; they float over the cards and fade. */
  reactions: LiveReaction[];
  /** The section's own fold, driven by the chevron at the end of its heading. */
  sectionOpen: boolean;
  onToggleSection: () => void;
}

/**
 * How large a card's portrait is drawn, from how many are on the call: one
 * gets the room, two share it, three stack, and past three the cards go
 * compact and sit three across with the overflow chip under them.
 */
export function portraitSizeFor(total: number): number {
  if (total <= 1) return 88;
  if (total === 2) return 72;
  if (total === 3) return 56;
  return 44;
}

/** At most this many cards are drawn; the rest live behind the overflow control. */
export const MAX_ROSTER_CARDS = 3;

/**
 * Who earns one of the three cards: the AI human always, then whoever is
 * making a sound, then the host, then us, then the order people arrived in.
 */
function rosterOrder(
  people: Participant[],
  presenceOf: (p: Participant) => ParticipantPresence,
  state: RoomState,
  selfId: string,
): Participant[] {
  const rank = (p: Participant): number => {
    const presence = presenceOf(p);
    if (presence === 'speaking') return 0;
    if (presence === 'floor') return 1;
    if (p.id === state.hostId) return 2;
    if (p.id === selfId) return 3;
    return 4;
  };
  return [...people].sort((a, b) => rank(a) - rank(b) || a.joinedAt - b.joinedAt);
}

/**
 * The tile: a face with its name under it, one fill for every state — the
 * ring is what changes. A column rather than a stack, so nothing is ever
 * painted over a face; the first version centred the avatar in the whole tile
 * and faded a scrim over the bottom of it, and at 44 px that scrim cut every
 * disc in half.
 */
const TILE_BASE =
  'group relative flex flex-col overflow-hidden rounded-lg bg-surface-container-high transition-[box-shadow] duration-[var(--duration-base)] ease-[var(--ease-out)]';

/**
 * The ring that says "this one has the room". Presence green while audible —
 * the colour this product already uses for a live voice, and the colour a
 * call UI is expected to use for its active speaker — and a plain outline for
 * whoever holds the floor without making a sound. Never the brand red: a red
 * box drawn round a person who is simply talking reads as an alarm.
 */
function ringFor(presence: ParticipantPresence): string {
  // Two pixels and no halo. A glow behind the ring was measured on screen and
  // it reads as neon in dark and as highlighter in light — a call UI marks its
  // active speaker with a line, not with a lamp.
  if (presence === 'speaking') return 'shadow-[0_0_0_2px_var(--color-presence)]';
  if (presence === 'floor') return 'shadow-[0_0_0_2px_var(--color-outline)]';
  return 'hairline';
}

/** Three little bars that move only while this person is actually audible. */
function SpeakingGlyph() {
  return (
    <span className="pen-bars flex h-2.5 shrink-0 items-end gap-[1.5px]" aria-hidden>
      <i />
      <i />
      <i />
      <style>{`
        .pen-bars i { width: 2px; border-radius: 1px; background: var(--color-presence); animation: pen-bar 900ms var(--ease-in-out) infinite; }
        .pen-bars i:nth-child(1) { height: 4px; animation-delay: 0ms; }
        .pen-bars i:nth-child(2) { height: 9px; animation-delay: 140ms; }
        .pen-bars i:nth-child(3) { height: 6px; animation-delay: 280ms; }
        @keyframes pen-bar { 0%, 100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
        @media (prefers-reduced-motion: reduce) { .pen-bars i { animation: none; transform: scaleY(0.8); } }
      `}</style>
    </span>
  );
}

/**
 * What a tile calls someone.
 *
 * Your own tile says "You" and nothing else — the name beside it would be a
 * label for other people, and Meet, Teams and Slack huddles all drop it. Three
 * across there is no room for two words, so a compact tile keeps the first
 * one: "Mina" rather than "Mina Far…", which is a word instead of a stump.
 */
export function tileNameFor(name: string, isSelf: boolean, compact: boolean): string {
  if (isSelf) return 'You';
  const trimmed = name.trim();
  if (!compact) return trimmed;
  return trimmed.split(/\s+/)[0] || trimmed;
}

/**
 * The quieter word beside the name: what this person is, when it is worth
 * saying. Never in brackets — a meeting app writes "Ada Lovelace  Host", not
 * "Ada Lovelace (Host)" — and never at all on a compact tile, where the name
 * itself is already cropped.
 */
function qualifierFor(
  kind: 'expert' | 'person',
  isSelf: boolean,
  isHostSeat: boolean,
  compact: boolean,
): string | null {
  if (kind === 'expert') return compact ? 'AI' : 'AI expert';
  if (isSelf || !isHostSeat || compact) return null;
  return 'Host';
}

/**
 * The face, and under it the name — bottom-left, small, on the tile's own
 * ground.
 *
 * The name is part of the tile rather than a pill laid on top of one: no
 * second background, no border, no blur. It is in the tile's flow, so it can
 * never sit over a face and never needs a film over one to stay legible,
 * which is the whole reason the version before this looked like a sticker.
 */
function TileFace({
  name,
  qualifier,
  glyph,
  children,
}: {
  name: string;
  qualifier: string | null;
  glyph: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 items-center justify-center px-2 pt-2.5 pb-1">
        {children}
      </div>
      <div className="flex items-center gap-1 px-2 pb-1.5" data-tile-name>
        {glyph}
        <span className="min-w-0 truncate text-label-small font-medium text-on-surface" dir="auto">
          {name}
        </span>
        {qualifier ? (
          <span className="shrink-0 text-label-small text-on-surface-dim">{qualifier}</span>
        ) : null}
      </div>
    </>
  );
}

/**
 * The small round control in a tile's top corner — and only when there is
 * something to press. `tone` is quiet unless the state is one a person has to
 * act on, which in a room is exactly two: the browser is holding the expert's
 * voice, and the host has muted you.
 */
function TileControl({
  label,
  tone,
  onClick,
  compact,
  children,
  testId,
}: {
  label: string;
  tone: 'quiet' | 'warn';
  onClick: () => void;
  compact: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn(
        'absolute top-1.5 end-1.5 z-[2] grid place-items-center rounded-full transition-[color,background-color,opacity] duration-[var(--duration-fast)] focus-visible:outline-primary',
        compact ? 'size-6' : 'size-7',
        tone === 'warn'
          ? // Something is waiting on a person: the host has silenced you, or
            // the browser is holding the expert's voice. Always on screen.
            'bg-warm-container text-on-warm-container'
          : // A shortcut, not a status. Meet and Zoom both keep these off the
            // face until you reach for the tile, and a crossed-out microphone
            // sitting permanently on somebody's tile reads as "she is muted"
            // when it means "mute her". The full list behind "everyone on the
            // call" carries the same controls for a touch screen.
            'bg-surface-container/90 text-on-surface-variant opacity-0 hairline group-hover:opacity-100 group-focus-within:opacity-100 hover:text-on-surface',
      )}
    >
      {children}
    </button>
  );
}

function ExpertTile({
  expert,
  presence,
  portraitUrl,
  size,
  compact,
  soundBlocked,
  onEnableSound,
  waiting = false,
}: {
  expert: Expert | null;
  presence: ExpertPresence;
  portraitUrl: string | null;
  size: number;
  compact: boolean;
  soundBlocked: boolean;
  onEnableSound: () => void;
  /** The class is in a discussion (ADR-0037): the expert waits, dimmed, and says so. */
  waiting?: boolean;
}) {
  const name = expert?.displayName ?? 'Expert';
  const talking = presence === 'speaking';
  return (
    <li
      data-testid="roster-expert"
      data-presence={waiting ? 'waiting' : presence}
      /* The tile follows the same rule as everyone else's — a green line while
         audible, a hairline otherwise. The finer states only the AI human has
         (thinking, listening for you) are the orb's to draw, and drawing them
         twice put a second grey box round the expert for half the lesson. */
      className={cn(
        TILE_BASE,
        ringFor(talking ? 'speaking' : 'listening'),
        // Dimmed, not gone: the expert is in the room and waiting for the host.
        waiting && 'opacity-50 transition-opacity duration-[var(--duration-base)]',
      )}
      style={{ minHeight: size + 46 }}
    >
      {/* The ring and the bars are the sighted read of this; a screen reader
          gets the same fact in words rather than nothing at all. */}
      <span className="sr-only">{waiting ? 'Waiting' : expertPresenceLabel(presence)}</span>
      <TileFace
        name={tileNameFor(name, false, compact)}
        qualifier={waiting ? 'waiting' : qualifierFor('expert', false, false, compact)}
        glyph={talking ? <SpeakingGlyph /> : null}
      >
        <ExpertOrb name={name} portraitUrl={portraitUrl} presence={presence} size={size} />
      </TileFace>
      {soundBlocked ? (
        <TileControl
          label={`Tap to hear ${name}`}
          tone="warn"
          compact={compact}
          onClick={onEnableSound}
          testId="roster-enable-sound"
        >
          <VolumeX size={13} />
        </TileControl>
      ) : null}
    </li>
  );
}

function PersonTile({
  p,
  presence,
  voice,
  size,
  compact,
  isSelf,
  isHostSeat,
  onToggleMic,
  onMute,
  hand = 0,
  calledOn = false,
}: {
  p: Participant;
  presence: ParticipantPresence;
  voice: VoiceState;
  size: number;
  compact: boolean;
  isSelf: boolean;
  isHostSeat: boolean;
  onToggleMic: () => void;
  onMute: (() => void) | null;
  /** Queue position of a raised hand, 1-based; 0 when down (ADR-0037). */
  hand?: number;
  /** The expert has just called on this person and is waiting to hear them. */
  calledOn?: boolean;
}) {
  const speaking = presence === 'speaking';
  const mutedByHost = isSelf && voice === 'muted';
  const handUp = (hand ?? 0) > 0;
  return (
    <li
      data-testid={`roster-${p.id}`}
      data-voice={voice}
      data-presence={presence}
      data-hand={handUp ? hand : calledOn ? 'called' : undefined}
      className={cn(TILE_BASE, 'relative', ringFor(presence))}
      style={{ minHeight: size + 46 }}
    >
      <span className="sr-only">
        {isHostSeat ? 'Host, ' : ''}
        {presenceLabel(presence, isHostSeat)}
        {handUp ? `, hand up, ${ordinalOf(hand ?? 0)} in line` : calledOn ? ', called on' : ''}
      </span>
      {/* The hand where the host's eye is: on the face, with its place in line. */}
      {handUp || calledOn ? (
        <span
          aria-hidden
          className={cn(
            'absolute top-1.5 right-1.5 z-[1] inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-label-small tabular-nums',
            calledOn
              ? 'bg-primary text-on-primary'
              : 'bg-primary-container text-on-primary-container',
          )}
          data-testid={`hand-tile-${p.id}`}
        >
          <Hand size={11} />
          {handUp ? hand : null}
        </span>
      ) : null}
      <TileFace
        name={tileNameFor(p.name, isSelf, compact)}
        qualifier={qualifierFor('person', isSelf, isHostSeat, compact)}
        glyph={
          speaking ? (
            <SpeakingGlyph />
          ) : voice === 'muted' ? (
            <MicOff size={11} className="shrink-0 text-on-surface-dim" aria-hidden />
          ) : null
        }
      >
        <Avatar name={p.name} hue={p.hue} size={size} />
      </TileFace>
      {isSelf ? (
        <TileControl
          label={mutedByHost ? 'Muted by the host — unmute' : 'Toggle your microphone'}
          tone={mutedByHost ? 'warn' : 'quiet'}
          compact={compact}
          onClick={onToggleMic}
        >
          {voice === 'on' || voice === 'speaking' ? <Mic size={13} /> : <MicOff size={13} />}
        </TileControl>
      ) : onMute && voice !== 'off' && voice !== 'muted' ? (
        <TileControl label={`Mute ${p.name}`} tone="quiet" compact={compact} onClick={onMute}>
          <MicOff size={13} />
        </TileControl>
      ) : null}
    </li>
  );
}

export function ParticipantRoster(p: ParticipantRosterProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const people = p.state.participants;
  const presenceOf = (person: Participant): ParticipantPresence =>
    participantPresence({
      participant: person,
      selfId: p.selfId,
      state: p.state,
      audio: p.audio,
      micState: p.micState,
      micLevel: p.micLevel,
    });
  const ordered = rosterOrder(people, presenceOf, p.state, p.selfId);
  // The AI human is always on the call and always has a card; the rest share
  // what is left of the three.
  const total = people.length + 1;
  const shownPeople = ordered.slice(0, Math.max(0, MAX_ROSTER_CARDS - 1));
  const hidden = total - (shownPeople.length + 1);
  const size = portraitSizeFor(total);
  /** Past three the cards go three across, and there is no room for a parenthetical. */
  const compact = total > MAX_ROSTER_CARDS;
  const voiceOn = p.audio !== null && p.audio.status !== 'off';
  const canMute = p.isHost && voiceOn && p.onMute !== null;
  const canRemove = p.isHost && Boolean(p.onRemove);
  /** Queue position of a raised hand, 1-based; 0 when the hand is down (ADR-0037). */
  const handOf = (id: string) =>
    (p.state.hands?.findIndex((h) => h.participantId === id) ?? -1) + 1;
  const calledOn = p.state.invited ?? null;
  const unmutedGuests = people.filter(
    (x) => x.id !== p.state.hostId && !['off', 'muted'].includes(voiceOf(x, p.selfId, p.audio)),
  );

  return (
    <section
      aria-labelledby={`${listId}-heading`}
      data-testid="roster"
      data-total={total}
      data-shown={p.sectionOpen ? Math.min(total, MAX_ROSTER_CARDS) : 0}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        {/* h6, like every other small section label in the room (the recap's
            own): these name a strip of the panel, they are not page headings,
            and putting them at h2 put two of them above the page's own. */}
        <h6
          id={`${listId}-heading`}
          className="shrink-0 whitespace-nowrap text-label-small font-semibold tracking-widest text-on-surface-dim uppercase"
        >
          On the call
        </h6>
        {/* The count, plainly. A bright green chip around a number is not news;
            the dot beside it is the only thing that has to say "live". */}
        <span className="flex shrink-0 items-center gap-1.5 text-label-small text-on-surface-dim tabular">
          {voiceOn && p.audio?.status === 'connected' ? (
            <span className="size-1.5 animate-blink rounded-full bg-presence" aria-hidden />
          ) : null}
          {total} {total === 1 ? 'participant' : 'participants'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="roster-section-toggle"
          aria-expanded={p.sectionOpen}
          aria-controls={`${listId}-body`}
          aria-label={p.sectionOpen ? 'Hide on the call' : 'Show on the call'}
          onClick={p.onToggleSection}
          className="grid size-6 shrink-0 place-items-center rounded-full text-on-surface-variant transition-colors duration-[var(--duration-fast)] hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-primary"
        >
          <ChevronDown
            size={14}
            aria-hidden
            className={cn(
              'transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)]',
              !p.sectionOpen && '-rotate-90 rtl:rotate-90',
            )}
          />
        </button>
      </div>

      {!p.sectionOpen ? null : (
        <div id={`${listId}-body`}>
          {/* The cards are the reactions' stage. The padding is the lane the
              pills rise into: `ReactionPills` hangs 12 px below this box, and
              without the lane a pill lands on the names. */}
          <div className="relative pb-6">
            {/* A list, because that is what it is: three faces read as three
                things rather than as one run-on paragraph. */}
            <ul
              className={cn('grid px-3', compact ? 'grid-cols-3 gap-2' : 'gap-2.5')}
              data-testid="roster-cards"
            >
              <ExpertTile
                expert={p.expert}
                presence={p.expertPresence}
                portraitUrl={p.expertPortraitUrl}
                size={size}
                compact={compact}
                soundBlocked={p.soundBlocked}
                onEnableSound={p.onEnableSound}
                waiting={p.state.mode === 'discussing'}
              />
              {shownPeople.map((person) => (
                <PersonTile
                  key={person.id}
                  p={person}
                  presence={presenceOf(person)}
                  voice={voiceOf(person, p.selfId, p.audio)}
                  size={size}
                  compact={compact}
                  isSelf={person.id === p.selfId}
                  isHostSeat={person.id === p.state.hostId}
                  onToggleMic={p.onToggleMic}
                  onMute={
                    canMute && person.id !== p.state.hostId ? () => p.onMute?.(person.id) : null
                  }
                  hand={handOf(person.id)}
                  calledOn={calledOn === person.id}
                />
              ))}
            </ul>
            <ReactionPills reactions={p.reactions} />
          </div>

          {/* The rest of the room: the overflow chip every call UI settles on. */}
          <div className="px-3">
            <button
              type="button"
              data-testid="participants-toggle"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-body-small text-on-surface-variant transition-colors duration-[var(--duration-fast)] hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-primary"
            >
              <span className="truncate tabular">
                {hidden > 0 ? `+${hidden} more` : 'Everyone on the call'}
              </span>
              <ChevronDown
                size={14}
                aria-hidden
                className={cn(
                  'shrink-0 transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)]',
                  open && 'rotate-180',
                )}
              />
            </button>
          </div>
        </div>
      )}

      {open && p.sectionOpen ? (
        <div id={listId} className="mt-1 px-3">
          <ul className="flex max-h-[240px] flex-col gap-0.5 overflow-auto rounded-md bg-surface-container-high/60 p-1">
            {people.map((person) => {
              const voice = voiceOf(person, p.selfId, p.audio);
              const presence = presenceOf(person);
              const isSelf = person.id === p.selfId;
              const host = person.id === p.state.hostId;
              return (
                <li
                  key={person.id}
                  className="flex items-center gap-2.5 rounded-sm px-2 py-1.5"
                  data-testid={`participant-${person.id}`}
                  data-voice={voice}
                >
                  <VoiceAvatar p={person} voice={voice} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-body-medium text-on-surface" dir="auto">
                        {person.name}
                      </span>
                      {isSelf ? (
                        <span className="shrink-0 text-label-small text-on-surface-dim">You</span>
                      ) : null}
                      {host ? <Pill tone="accent">Host</Pill> : null}
                      {handOf(person.id) > 0 ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary-container px-1.5 py-0.5 text-label-small text-on-primary-container"
                          title={`Hand up, ${ordinalOf(handOf(person.id))} in line`}
                          data-testid={`hand-${person.id}`}
                        >
                          <Hand size={11} aria-hidden />
                          {handOf(person.id)}
                        </span>
                      ) : calledOn === person.id ? (
                        <Pill tone="warm">Called on</Pill>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        'text-label-small',
                        presence === 'speaking' ? 'text-presence' : 'text-on-surface-dim',
                      )}
                    >
                      {voiceOn ? VOICE_LABEL[voice] : presenceLabel(presence, host)}
                    </div>
                  </div>
                  {canMute && !host && !isSelf ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={voice === 'off' || voice === 'muted'}
                      onClick={() => p.onMute?.(person.id)}
                      leading={<MicOff size={13} />}
                      data-testid={`mute-${person.id}`}
                    >
                      {voice === 'muted' ? 'Muted' : 'Mute'}
                    </Button>
                  ) : null}
                  {canRemove && !host && !isSelf ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => p.onRemove?.(person.id)}
                      leading={<UserMinus size={13} />}
                      aria-label={`Remove ${person.name} from the room`}
                      data-testid={`remove-${person.id}`}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canMute ? (
            <div className="mt-1.5">
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={unmutedGuests.length === 0}
                onClick={() => p.onMute?.()}
                leading={<MicOff size={13} />}
                data-testid="mute-all"
              >
                Mute everyone
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ordinalOf(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}
