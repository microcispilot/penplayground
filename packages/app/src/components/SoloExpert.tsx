import type { Expert } from '@pen/contracts';
import { cn, ExpertOrb, type ExpertPresence } from '@pen/design';
import { VolumeX } from 'lucide-react';
import { expertPresenceLabel } from '../room/presence.js';

/**
 * The expert, when there is nobody else in the room.
 *
 * Most sessions are one learner and one expert, and for those the side panel
 * was furniture pretending to be a feature: a roster of two, and a chat in a
 * room where you are the only person who can type. The owner: *"when a chat
 * is not needed, then that's silly to show it. we should have a different
 * layout for that situation."*
 *
 * So a solo session has no panel at all, and this is what takes its place —
 * one small tile over the board, the way a self-view sits in Meet. It is the
 * whole of the roster that still means something alone:
 *
 *   · **the expert is here**, with a face rather than a name in a list;
 *   · **what they are doing right now** — listening, thinking, speaking —
 *     which is the one thing that keeps a voice-first lesson from feeling
 *     like a page that has stopped loading;
 *   · **the browser holding their voice**, which is the only state in the
 *     old roster a learner had to act on, and which would otherwise have
 *     nowhere left to be said.
 *
 * Everything else the panel carried is gone rather than moved: a chat with
 * nobody in it, a participant list of one, and a reaction nobody would see.
 */
export function SoloExpert({
  expert,
  presence,
  portraitUrl,
  soundBlocked,
  onEnableSound,
}: {
  expert: Expert | null;
  presence: ExpertPresence;
  portraitUrl: string | null;
  soundBlocked: boolean;
  onEnableSound: () => void;
}) {
  const name = expert?.displayName ?? 'Expert';
  const first = name.split(' ')[0] ?? name;
  const label = soundBlocked ? `Tap to hear ${first}` : expertPresenceLabel(presence);

  const body = (
    <>
      <ExpertOrb
        name={name}
        portraitUrl={portraitUrl}
        presence={soundBlocked ? 'idle' : presence}
        size={40}
      />
      <span className="flex min-w-0 flex-col items-start">
        <span className="max-w-[140px] truncate text-label-large text-on-surface" dir="auto">
          {name}
        </span>
        <span
          className={cn(
            'flex items-center gap-1 text-label-small',
            soundBlocked ? 'text-on-warm-container' : 'text-on-surface-variant',
          )}
        >
          {soundBlocked ? <VolumeX size={12} aria-hidden /> : null}
          {label}
        </span>
      </span>
    </>
  );

  const shell = cn(
    // Over the board, never on it: the board is the lesson and this is the
    // person teaching it. Logical inset so it mirrors in a Persian session.
    'absolute bottom-3 end-3 z-[7] flex items-center gap-2.5 rounded-xl px-2.5 py-2',
    'bg-surface-container-high shadow-level2 hairline',
  );

  // Blocked sound is the one state here that is a thing to *do*, so it is the
  // one state where this becomes a button. Otherwise it is what it looks
  // like: somebody standing there.
  if (soundBlocked)
    return (
      <button
        type="button"
        onClick={onEnableSound}
        data-testid="solo-expert"
        data-presence={presence}
        aria-label={`Tap to hear ${name}`}
        className={cn(shell, 'state-layer text-start')}
      >
        {body}
      </button>
    );

  return (
    <div
      data-testid="solo-expert"
      data-presence={presence}
      className={shell}
      role="img"
      aria-label={`${name}, ${label.toLowerCase()}`}
    >
      {body}
    </div>
  );
}
