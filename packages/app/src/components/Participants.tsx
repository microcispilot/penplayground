import type { Participant, RoomState } from '@pen/contracts';
import { Avatar, Button, cn, Pill } from '@pen/design';
import { MicOff, Users } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { RoomAudioUi } from '../room/audio/RoomAudio.js';

export interface ParticipantsControlProps {
  state: RoomState;
  isHost: boolean;
  selfId: string;
  /** Null in solo sessions (no voice between participants). */
  audio: RoomAudioUi | null;
  /** Host only; `undefined` mutes everyone but the host. */
  onMute: ((participantId?: string) => void) | null;
}

type VoiceState = 'speaking' | 'muted' | 'on' | 'off';

function voiceOf(p: Participant, selfId: string, audio: RoomAudioUi | null): VoiceState {
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
function VoiceAvatar({ p, voice, size }: { p: Participant; voice: VoiceState; size: number }) {
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
            'shadow-[0_0_0_2px_var(--color-surface),0_0_0_4px_var(--color-presence)]',
          voice === 'muted' && 'opacity-60',
        )}
      />
      {voice === 'muted' ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-danger text-on-accent ring-2 ring-surface"
          aria-hidden
        >
          <MicOff size={8} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The bottom bar's people control: the avatar stack (speaking rings, mute
 * badges) opens a popover listing everyone in the room with their voice state;
 * the host gets a mute button per guest and "Mute everyone".
 */
export function ParticipantsControl({
  state,
  isHost,
  selfId,
  audio,
  onMute,
}: ParticipantsControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const people = state.participants;
  const voiceOn = audio !== null && audio.status !== 'off';
  const canMute = isHost && voiceOn && onMute !== null;

  // Close on Escape and on a click outside, the way a menu behaves.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const guestsOnVoice = people.filter(
    (p) => p.id !== state.hostId && voiceOf(p, selfId, audio) !== 'off',
  );
  const unmutedGuests = guestsOnVoice.filter((p) => voiceOf(p, selfId, audio) !== 'muted');

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 focus-visible:outline-accent',
          open && 'bg-surface-2',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Participants (${people.length})`}
        title="Participants"
        data-testid="participants-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex -space-x-2">
          {people.slice(0, 5).map((x) => (
            <VoiceAvatar key={x.id} p={x} voice={voiceOf(x, selfId, audio)} size={28} />
          ))}
        </span>
        {people.length > 5 ? (
          <span className="text-xs text-fg-2 tabular">+{people.length - 5}</span>
        ) : null}
        {people.length <= 1 ? <Users size={14} className="text-fg-3" aria-hidden /> : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Participants"
          className="absolute right-0 bottom-[calc(100%+10px)] z-[20] w-[300px] animate-rise rounded-[var(--radius-lg)] bg-bg-elevated p-2 shadow-pop hairline"
        >
          <div className="flex items-center justify-between px-2 pt-1 pb-2">
            <span className="text-xs font-medium tracking-[0.08em] text-fg-3 uppercase">
              In the room · {people.length}
            </span>
            {voiceOn ? (
              <Pill
                tone={audio?.status === 'connected' ? 'live' : 'warm'}
                dot={audio?.status === 'connected'}
              >
                {audio?.status === 'connected'
                  ? 'Voice on'
                  : audio?.status === 'failed'
                    ? 'Voice off'
                    : 'Connecting…'}
              </Pill>
            ) : null}
          </div>
          <ul className="flex max-h-[320px] flex-col gap-0.5 overflow-auto">
            {people.map((p) => {
              const voice = voiceOf(p, selfId, audio);
              const isSelf = p.id === selfId;
              const host = p.id === state.hostId;
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5"
                  data-testid={`participant-${p.id}`}
                  data-voice={voice}
                >
                  <VoiceAvatar p={p} voice={voice} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-fg">
                        {p.name}
                        {isSelf ? <span className="text-fg-3"> (you)</span> : null}
                      </span>
                      {host ? <Pill tone="accent">Host</Pill> : null}
                    </div>
                    <div
                      className={cn(
                        'text-[11.5px]',
                        voice === 'speaking' ? 'text-presence' : 'text-fg-3',
                      )}
                    >
                      {voiceOn ? VOICE_LABEL[voice] : host ? 'Hosting' : 'Listening'}
                    </div>
                  </div>
                  {canMute && !host && !isSelf ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={voice === 'off' || voice === 'muted'}
                      onClick={() => onMute?.(p.id)}
                      leading={<MicOff size={13} />}
                      data-testid={`mute-${p.id}`}
                    >
                      {voice === 'muted' ? 'Muted' : 'Mute'}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canMute ? (
            <div className="mt-1 border-t border-line px-1 pt-2">
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={unmutedGuests.length === 0}
                onClick={() => onMute?.()}
                leading={<MicOff size={13} />}
                data-testid="mute-all"
              >
                Mute everyone
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
