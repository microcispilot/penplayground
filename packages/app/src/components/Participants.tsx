import type { Expert, Participant, RoomState } from '@pen/contracts';
import { Avatar, Button, cn, ExpertOrb, type ExpertPresence, Pill } from '@pen/design';
import { ChevronDown, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
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
          voice === 'muted' && 'opacity-60',
        )}
      />
      {voice === 'muted' ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-warm text-on-primary ring-2 ring-surface-container-low"
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
 * The layout follows the count, the way a call grid does: one card is given
 * room, three are compact, and past three only three are shown with an
 * overflow control — the avatar-stack-with-overflow pattern Google Meet,
 * Figma and Linear all settled on, because a roster that grows without bound
 * pushes the conversation off the screen.
 *
 * Whoever holds the floor is ringed, and whoever is audible right now is
 * ringed and glowing. Both come from state the room broadcasts (`floor`, the
 * media server's active speakers, this device's own microphone level), so a
 * silent participant is never animated.
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

const CARD_BASE =
  'relative flex items-center justify-center overflow-hidden rounded-lg bg-surface-container-high transition-[box-shadow,background-color] duration-[var(--duration-base)] ease-[var(--ease-out)]';

/** The ring that says "this one has the room": bright and glowing while audible, quiet while merely holding the floor. */
function ringFor(presence: ParticipantPresence): string {
  if (presence === 'speaking')
    return 'shadow-[0_0_0_2px_var(--color-primary),0_0_0_7px_var(--color-primary-container)]';
  if (presence === 'floor') return 'shadow-[0_0_0_2px_var(--color-primary-container)]';
  return 'shadow-[0_0_0_1px_var(--color-outline-variant)]';
}

/**
 * The name, bottom-left of its card, with what they are in muted weight
 * beside it. Three across there is no room for the parenthetical, so the card
 * keeps the name (which is what a face needs) and the control's label carries
 * the rest.
 */
/** Three little bars that move only while this person is actually audible. */
function SpeakingGlyph() {
  return (
    <span className="pen-bars flex h-3 shrink-0 items-end gap-[1.5px]" aria-hidden>
      <i />
      <i />
      <i />
      <style>{`
        .pen-bars i { width: 2px; border-radius: 1px; background: var(--color-presence); animation: pen-bar 900ms var(--ease-in-out) infinite; }
        .pen-bars i:nth-child(1) { height: 5px; animation-delay: 0ms; }
        .pen-bars i:nth-child(2) { height: 10px; animation-delay: 140ms; }
        .pen-bars i:nth-child(3) { height: 7px; animation-delay: 280ms; }
        @keyframes pen-bar { 0%, 100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
        @media (prefers-reduced-motion: reduce) { .pen-bars i { animation: none; transform: scaleY(0.8); } }
      `}</style>
    </span>
  );
}

function NamePill({
  name,
  note,
  compact,
  speaking,
}: {
  name: string;
  note: string;
  compact: boolean;
  speaking: boolean;
}) {
  if (compact)
    return (
      <span className="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex items-center justify-center gap-1 rounded-full bg-surface-container/88 px-2 py-0.5 text-label-small font-medium text-on-surface backdrop-blur-[6px] hairline">
        {speaking ? <SpeakingGlyph /> : null}
        <span className="min-w-0 truncate" dir="auto">
          {name}
        </span>
      </span>
    );
  return (
    <span className="pointer-events-none absolute end-11 bottom-2 start-2 flex min-w-0 items-center gap-1.5 rounded-full bg-surface-container/88 px-2.5 py-1 text-label-small text-on-surface backdrop-blur-[6px] hairline">
      {speaking ? <SpeakingGlyph /> : null}
      <span className="min-w-0 truncate font-medium" dir="auto">
        {name}
      </span>
      <span className="shrink-0 text-on-surface-dim">({note})</span>
    </span>
  );
}

/** The small round control in a card's top-right corner: the speaker, or a microphone. */
function CardControl({
  label,
  tone,
  onClick,
  children,
  testId,
}: {
  label: string;
  tone: 'quiet' | 'live' | 'warn';
  onClick?: (() => void) | undefined;
  children: ReactNode;
  testId?: string;
}) {
  const className = cn(
    'absolute top-2 end-2 grid size-7 place-items-center rounded-full backdrop-blur-[6px] transition-colors duration-[var(--duration-fast)]',
    tone === 'live' &&
      'bg-presence-container text-on-presence-container shadow-[0_0_0_1px_var(--color-presence)]',
    tone === 'warn' &&
      'bg-warm-container text-on-warm-container shadow-[0_0_0_1px_var(--color-warm)]',
    tone === 'quiet' && 'bg-surface-container/88 text-on-surface-variant hairline',
    onClick && 'hover:text-on-surface focus-visible:outline-primary',
  );
  if (!onClick)
    return (
      <span className={className} role="img" aria-label={label} title={label}>
        {children}
      </span>
    );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={className}
    >
      {children}
    </button>
  );
}

function ExpertCard({
  expert,
  presence,
  portraitUrl,
  size,
  compact,
  soundBlocked,
  onEnableSound,
}: {
  expert: Expert | null;
  presence: ExpertPresence;
  portraitUrl: string | null;
  size: number;
  compact: boolean;
  soundBlocked: boolean;
  onEnableSound: () => void;
}) {
  const name = expert?.displayName ?? 'Expert';
  const talking = presence === 'speaking';
  return (
    <div
      data-testid="roster-expert"
      data-presence={presence}
      className={cn(
        CARD_BASE,
        ringFor(talking ? 'speaking' : presence === 'listening' ? 'floor' : 'listening'),
      )}
      style={{ minHeight: size + 40 }}
    >
      <ExpertOrb name={name} portraitUrl={portraitUrl} presence={presence} size={size} />
      <NamePill name={name} note="AI expert" compact={compact} speaking={talking} />
      <CardControl
        label={soundBlocked ? `Tap to hear ${name}` : `${name} · ${expertPresenceLabel(presence)}`}
        tone={soundBlocked ? 'warn' : talking ? 'live' : 'quiet'}
        {...(soundBlocked ? { onClick: onEnableSound, testId: 'roster-enable-sound' } : {})}
      >
        {soundBlocked ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </CardControl>
    </div>
  );
}

function PersonCard({
  p,
  presence,
  voice,
  size,
  compact,
  isSelf,
  isHostSeat,
  onToggleMic,
  onMute,
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
}) {
  const note = isSelf ? 'You' : isHostSeat ? 'Host' : presenceLabel(presence, isHostSeat);
  const micLive = isSelf
    ? presence === 'speaking' || voice === 'on' || voice === 'speaking'
    : false;
  const control = isSelf
    ? {
        label: voice === 'muted' ? 'Muted by the host — unmute' : 'Toggle your microphone',
        tone:
          voice === 'muted' ? ('warn' as const) : micLive ? ('live' as const) : ('quiet' as const),
        onClick: onToggleMic,
        icon:
          voice === 'muted' ? (
            <MicOff size={13} />
          ) : micLive ? (
            <Mic size={13} />
          ) : (
            <MicOff size={13} />
          ),
        testId: undefined,
      }
    : {
        label:
          voice === 'muted'
            ? `${p.name} is muted`
            : onMute
              ? `Mute ${p.name}`
              : `${p.name} · ${VOICE_LABEL[voice]}`,
        tone:
          voice === 'muted'
            ? ('warn' as const)
            : voice === 'speaking'
              ? ('live' as const)
              : ('quiet' as const),
        onClick: onMute && voice !== 'off' && voice !== 'muted' ? onMute : undefined,
        icon: voice === 'muted' ? <MicOff size={13} /> : <Mic size={13} />,
        testId: undefined,
      };
  return (
    <div
      data-testid={`roster-${p.id}`}
      data-voice={voice}
      data-presence={presence}
      className={cn(CARD_BASE, ringFor(presence))}
      style={{ minHeight: size + 40 }}
    >
      <Avatar name={p.name} hue={p.hue} size={size} />
      <NamePill name={p.name} note={note} compact={compact} speaking={presence === 'speaking'} />
      <CardControl label={control.label} tone={control.tone} onClick={control.onClick}>
        {control.icon}
      </CardControl>
    </div>
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
        <Pill tone={voiceOn ? 'live' : 'neutral'} dot={voiceOn && p.audio?.status === 'connected'}>
          {total} {total === 1 ? 'participant' : 'participants'}
        </Pill>
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
          {/* The cards are the reactions' stage: pills rise over the faces. */}
          <div className="relative">
            <div
              className={cn('grid px-3', compact ? 'grid-cols-3 gap-2' : 'gap-2.5')}
              data-testid="roster-cards"
            >
              <ExpertCard
                expert={p.expert}
                presence={p.expertPresence}
                portraitUrl={p.expertPortraitUrl}
                size={size}
                compact={compact}
                soundBlocked={p.soundBlocked}
                onEnableSound={p.onEnableSound}
              />
              {shownPeople.map((person) => (
                <PersonCard
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
                />
              ))}
            </div>
            <ReactionPills reactions={p.reactions} />
          </div>

          {/* The rest of the room: the overflow chip every call UI settles on. */}
          <div className="px-3 pt-2">
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
                  <VoiceAvatar p={person} voice={voice} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-body-medium text-on-surface" dir="auto">
                        {person.name}
                        {isSelf ? <span className="text-on-surface-dim"> (you)</span> : null}
                      </span>
                      {host ? <Pill tone="accent">Host</Pill> : null}
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
