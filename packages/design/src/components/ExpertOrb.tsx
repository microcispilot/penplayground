import { cn } from '../cn.js';

/**
 * The expert's presence: a frosted circle with a feathered conic ring and the
 * portrait inside. Ported from Simurgh's CompanionPuck/CompanionOrb (pure CSS,
 * no canvas). `presence` drives the ring exactly as the desktop does:
 *   idle      — quiet ring, no animation (energy policy)
 *   thinking  — bounded orbit, two turns, then rests
 *   speaking  — bright ring + staggered ripples
 *   listening — presence-green rim + single slow ripple
 *   paused    — dimmed
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

const AI_CONIC =
  'conic-gradient(from 0deg, oklch(0.62 0.15 262), oklch(0.66 0.19 300), oklch(0.85 0.12 88), oklch(0.8 0.13 175), oklch(0.62 0.15 262))';

export function ExpertOrb({
  name,
  portraitUrl,
  presence,
  size = 88,
  className,
  caption,
}: ExpertOrbProps) {
  const rim =
    presence === 'listening'
      ? 'var(--color-presence)'
      : presence === 'speaking'
        ? 'var(--color-speaking)'
        : presence === 'thinking'
          ? 'oklch(0.85 0.12 88)'
          : 'oklch(1 0 0 / 22%)';
  const inner = Math.round(size * 0.76);
  return (
    <div
      className={cn('flex flex-col items-center gap-2', className)}
      data-presence={presence}
      aria-live="polite"
    >
      <div
        role="img"
        aria-label={`${name}, ${presence}`}
        className="relative grid place-items-center rounded-full"
        style={{
          width: size,
          height: size,
          background:
            'radial-gradient(120% 90% at 50% 0%, oklch(0.62 0.15 262 / 30%), transparent 62%), radial-gradient(120% 85% at 50% 100%, oklch(0.8 0.13 175 / 14%), transparent 58%), linear-gradient(160deg, oklch(0.3 0.04 280 / 90%), oklch(0.26 0.04 285 / 92%))',
          backdropFilter: 'blur(34px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(34px) saturate(1.3)',
          boxShadow:
            'inset 0 1px 0 oklch(1 0 0 / 8%), inset 0 -10px 26px oklch(0.3 0.06 285 / 30%), 0 6px 18px oklch(0 0 0 / 32%)',
          opacity: presence === 'paused' ? 0.7 : 1,
          transition: 'opacity var(--duration-slow) var(--ease-out)',
        }}
      >
        <span
          aria-hidden
          className={cn(
            'pen-orb-ring absolute rounded-full',
            presence === 'thinking' && 'pen-orb-ring--thinking',
          )}
          style={{
            inset: -5,
            background: AI_CONIC,
            WebkitMask:
              'radial-gradient(farthest-side, transparent calc(100% - 11px), #000 calc(100% - 7px), #000 calc(100% - 3px), transparent 100%)',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 11px), #000 calc(100% - 7px), #000 calc(100% - 3px), transparent 100%)',
            filter: presence === 'listening' ? 'blur(2.5px)' : 'blur(1.5px)',
            opacity:
              presence === 'idle'
                ? 0.45
                : presence === 'paused'
                  ? 0.35
                  : presence === 'speaking'
                    ? 1
                    : 0.85,
            transition: 'opacity var(--duration-slow) var(--ease-out), filter var(--duration-slow)',
          }}
        />
        {presence === 'speaking' || presence === 'listening' ? (
          <>
            <span
              aria-hidden
              className="pen-orb-ripple absolute inset-0 rounded-full"
              style={{ borderColor: rim }}
            />
            {presence === 'speaking' ? (
              <span
                aria-hidden
                className="pen-orb-ripple absolute inset-0 rounded-full"
                style={{ borderColor: rim, animationDelay: '180ms' }}
              />
            ) : null}
          </>
        ) : null}
        {portraitUrl ? (
          <img
            src={portraitUrl}
            alt=""
            width={inner}
            height={inner}
            decoding="async"
            className="rounded-full object-cover"
            style={{
              width: inner,
              height: inner,
              border: `2px solid ${rim}`,
              transition: 'border-color var(--duration-slow)',
            }}
          />
        ) : (
          <span
            className="grid place-items-center rounded-full font-display text-white"
            style={{
              width: inner,
              height: inner,
              border: `2px solid ${rim}`,
              background: 'oklch(0.6 0.1 216 / 30%)',
              fontSize: inner * 0.4,
            }}
          >
            {name.trim()[0]?.toUpperCase() ?? '?'}
          </span>
        )}
      </div>
      {caption ? (
        <span className="text-label-medium text-on-surface-variant">{caption}</span>
      ) : null}
      <style>{`
        .pen-orb-ripple { border: 2px solid; animation: pen-orb-ripple 800ms var(--ease-out) infinite; pointer-events: none; }
        [data-presence='speaking'] .pen-orb-ripple { animation-duration: 650ms; }
        @keyframes pen-orb-ripple { from { transform: scale(1); opacity: 0.55; } to { transform: scale(1.32); opacity: 0; } }
        .pen-orb-ring--thinking { animation: pen-orb-orbit 1.4s ease-out 2; }
        @keyframes pen-orb-orbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .pen-orb-ripple, .pen-orb-ring--thinking { animation: none; } }
      `}</style>
    </div>
  );
}
