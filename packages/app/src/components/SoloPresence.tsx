import type { Expert, Participant } from '@pen/contracts';
import { Avatar, cn, ExpertOrb, type ExpertPresence } from '@pen/design';
import { MicOff, VolumeX } from 'lucide-react';
import type { RoomAudioUi } from '../room/audio/RoomAudio.js';
import { expertPresenceLabel } from '../room/presence.js';
import { voiceOf } from './Participants.js';

/**
 * Who is on the call, when the call is two.
 *
 * Most sessions are one learner and one expert, and for those the side panel
 * was furniture pretending to be a feature: a roster of two and a chat in a
 * room where you are the only person who can type (ADR-0033). So a solo
 * session has no panel — and this is what takes its place.
 *
 * **Both people, not one.** The first version of this showed only the
 * expert, on the reasoning that you know where you are. The owner: *"even if
 * there's solo person, they should always see an avatar of the expert and
 * themselves. like in zoom and other apps you can see."* Right, and for the
 * reason every meeting app does it: a self-view is how you know the room can
 * see and hear *you*. Take it away and the only feedback that your
 * microphone is working is that the expert answers — which is exactly the
 * moment it is too late to find out.
 *
 * So: a strip of two small tiles over the board's lower corner, the way a
 * self-view sits in Meet. The expert's says what they are doing — listening,
 * thinking, speaking — which is what keeps a voice-first lesson from being
 * indistinguishable from a page that stopped loading. Yours says whether you
 * are heard.
 *
 * Neither is a control. The microphone lives in the bar, where it has always
 * been, and a second one here would be two switches for one thing. The sole
 * exception is the browser holding the expert's voice: that is the one state
 * a learner must *act* on, and with the panel gone this is the only place
 * left to say it.
 */
export function SoloPresence({
  expert,
  presence,
  portraitUrl,
  self,
  audio,
  soundBlocked,
  onEnableSound,
}: {
  expert: Expert | null;
  presence: ExpertPresence;
  portraitUrl: string | null;
  /** The learner themselves, as the room knows them; null before the room answers. */
  self: Participant | null;
  audio: RoomAudioUi | null;
  soundBlocked: boolean;
  onEnableSound: () => void;
}) {
  const name = expert?.displayName ?? 'Expert';
  const first = name.split(' ')[0] ?? name;
  const expertLabel = soundBlocked ? `Tap to hear ${first}` : expertPresenceLabel(presence);
  const voice = self ? voiceOf(self, self.id, audio) : 'off';
  const youLabel =
    voice === 'speaking'
      ? 'Speaking'
      : voice === 'muted'
        ? 'Muted'
        : voice === 'on'
          ? 'Mic on'
          : 'Mic off';

  return (
    <div
      // Over the board, never on it: the board is the lesson. Logical inset,
      // so the day the room's chrome mirrors, this mirrors with it.
      className="absolute bottom-3 end-3 z-[7] flex flex-col items-stretch gap-1.5"
      data-testid="solo-presence"
    >
      <Tile
        testId="solo-expert"
        presence={soundBlocked ? 'idle' : presence}
        label={expertLabel}
        name={name}
        warn={soundBlocked}
        {...(soundBlocked ? { onClick: onEnableSound, action: `Tap to hear ${name}` } : {})}
      >
        <ExpertOrb
          name={name}
          portraitUrl={portraitUrl}
          presence={soundBlocked ? 'idle' : presence}
          size={34}
        />
      </Tile>
      <Tile
        testId="solo-self"
        presence={voice === 'speaking' ? 'speaking' : 'idle'}
        label={youLabel}
        name="You"
        glyph={voice === 'muted' || voice === 'off' ? <MicOff size={11} aria-hidden /> : null}
      >
        <Avatar
          name={self?.name ?? 'You'}
          {...(self ? { hue: self.hue } : {})}
          size={34}
          className={cn(
            'transition-shadow duration-[var(--duration-fast)]',
            voice === 'speaking' && 'shadow-[0_0_0_2px_var(--color-presence)]',
          )}
        />
      </Tile>
    </div>
  );
}

/** One tile: a face, a name and one word about them. A button only when there is something to press. */
function Tile({
  children,
  name,
  label,
  presence,
  testId,
  warn = false,
  glyph = null,
  onClick,
  action,
}: {
  children: React.ReactNode;
  name: string;
  label: string;
  presence: string;
  testId: string;
  warn?: boolean;
  glyph?: React.ReactNode;
  onClick?: () => void;
  action?: string;
}) {
  const shell = cn(
    'flex items-center gap-2 rounded-xl px-2 py-1.5',
    'bg-surface-container-high shadow-level2 hairline',
  );
  const body = (
    <>
      {children}
      <span className="flex min-w-0 flex-col items-start">
        <span className="max-w-[128px] truncate text-label-medium text-on-surface" dir="auto">
          {name}
        </span>
        <span
          className={cn(
            'flex items-center gap-1 text-label-small',
            warn ? 'text-on-warm-container' : 'text-on-surface-variant',
          )}
        >
          {warn ? <VolumeX size={11} aria-hidden /> : glyph}
          {label}
        </span>
      </span>
    </>
  );

  if (onClick)
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        data-presence={presence}
        aria-label={action ?? label}
        className={cn(shell, 'state-layer text-start')}
      >
        {body}
      </button>
    );

  return (
    <div
      data-testid={testId}
      data-presence={presence}
      className={shell}
      role="img"
      aria-label={`${name}, ${label.toLowerCase()}`}
    >
      {body}
    </div>
  );
}
