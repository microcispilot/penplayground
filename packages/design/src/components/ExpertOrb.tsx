import { cn } from '../cn.js';
import { Avatar } from './Avatar.js';

/**
 * The AI human's face, with what it is doing drawn around it.
 *
 * This was a port of Simurgh's CompanionOrb: a frosted *dark* puck, a
 * feathered iridescent conic ring, and a portrait sunk inside it at 76 % of
 * the circle. Three things were wrong with it here, and none of them was the
 * idea:
 *
 *   It ignored the theme. Every colour in it was a literal — a violet-grey
 *   gradient, `oklch(1 0 0 / 22%)` for the rim — so in the product's light
 *   theme a dark lacquered disc sat in the middle of a matte grey panel. This
 *   one is made of tokens and is the same object in both themes.
 *
 *   It was a different design language. Beside a properly-built person tile
 *   the rainbow read as a widget from another app, and "AI" is not a thing
 *   iridescence says — it is a thing a label says, which is what the roster
 *   now does, quietly, in the name row.
 *
 *   It hid the face. 76 % of the circle went to the portrait and the rest to
 *   chrome, so at the 44 px a three-across roster gives it, the expert was a
 *   28 px thumbnail inside a ring. Now the portrait *is* the circle and the
 *   state is a ring around it, exactly as a meeting app frames an active
 *   speaker.
 *
 * What is kept is the vocabulary, because it is the honest one: every value
 * below is a state the conductor actually broadcasts, and nothing animates
 * for an expert that is not doing anything (the energy policy the desktop
 * holds to).
 *
 *   idle      — a hairline, no animation
 *   listening — a presence-green rim: the microphone is live
 *   thinking  — a brand arc, two turns, then it rests
 *   speaking  — a green rim, a soft halo and one ripple
 *   paused    — dimmed to a hairline
 */
export type ExpertPresence = 'idle' | 'thinking' | 'speaking' | 'listening' | 'paused';

export interface ExpertOrbProps {
  name: string;
  portraitUrl: string | null;
  presence: ExpertPresence;
  size?: number;
  className?: string;
  /** Show a small caption under the orb ("Ada · listening"). */
  caption?: string;
}

/**
 * Green means audible in this product — it is what the media server's
 * "speaking" reports paint, on every face in the roster — so the AI human
 * uses the same green rather than a colour of its own. The brand is reserved
 * for the one state only it has: thinking.
 */
const RING: Record<ExpertPresence, string> = {
  idle: '0 0 0 1px var(--color-outline-variant)',
  paused: '0 0 0 1px var(--color-outline-variant)',
  listening: '0 0 0 2px var(--color-presence)',
  thinking: '0 0 0 2px var(--color-primary)',
  speaking: '0 0 0 2px var(--color-presence), 0 0 0 5px var(--color-presence-container)',
};

export function ExpertOrb({
  name,
  portraitUrl,
  presence,
  size = 88,
  className,
  caption,
}: ExpertOrbProps) {
  return (
    <div
      className={cn('flex flex-col items-center gap-2', className)}
      data-presence={presence}
      aria-live="polite"
    >
      <div
        role="img"
        aria-label={`${name}, ${presence}`}
        className="pen-orb relative grid shrink-0 place-items-center rounded-full"
        style={{
          width: size,
          height: size,
          // The elevation is what lifts it off a sheet of paper in the replay,
          // where it floats over the board rather than sitting in a panel.
          boxShadow: `${RING[presence]}, var(--shadow-level2)`,
          opacity: presence === 'paused' ? 0.65 : 1,
          transition:
            'opacity var(--duration-slow) var(--ease-out), box-shadow var(--duration-slow) var(--ease-out)',
        }}
      >
        {presence === 'thinking' ? (
          <span
            aria-hidden
            className="pen-orb-arc absolute rounded-full"
            style={{
              inset: -3,
              background:
                'conic-gradient(from 0deg, var(--color-primary) 0deg, var(--color-primary) 40deg, transparent 150deg, transparent 360deg)',
              WebkitMask:
                'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
              mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
            }}
          />
        ) : null}
        {presence === 'speaking' ? (
          <span
            aria-hidden
            className="pen-orb-ripple absolute inset-0 rounded-full"
            style={{ borderColor: 'var(--color-presence)' }}
          />
        ) : null}
        {portraitUrl ? (
          <img
            src={portraitUrl}
            alt=""
            width={size}
            height={size}
            decoding="async"
            className="size-full rounded-full object-cover"
          />
        ) : (
          <Avatar name={name} size={size} />
        )}
      </div>
      {caption ? (
        <span className="text-label-medium text-on-surface-variant">{caption}</span>
      ) : null}
      <style>{`
        .pen-orb-ripple { border: 2px solid; animation: pen-orb-ripple 900ms var(--ease-out) infinite; pointer-events: none; }
        @keyframes pen-orb-ripple { from { transform: scale(1); opacity: 0.5; } to { transform: scale(1.28); opacity: 0; } }
        .pen-orb-arc { animation: pen-orb-orbit 1.4s var(--ease-in-out) 2; }
        @keyframes pen-orb-orbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .pen-orb-ripple, .pen-orb-arc { animation: none; } }
      `}</style>
    </div>
  );
}
