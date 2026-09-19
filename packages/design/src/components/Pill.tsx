import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type PillTone = 'neutral' | 'live' | 'accent' | 'warm' | 'danger';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  dot?: boolean;
}

/**
 * A static tonal label — "AI expert", "Live", "Complete".
 *
 * Not a control, so it takes no state layer; it is one of M3's
 * container/on-container pairs at `corner-full` with a `label-small` word
 * inside. Every tone is a generated pair, which is why none of them needs a
 * border to be read.
 */
const tones: Record<PillTone, string> = {
  neutral: 'bg-surface-container-high text-on-surface-variant',
  live: 'bg-presence-container text-on-presence-container',
  accent: 'bg-primary-container text-on-primary-container',
  warm: 'bg-warm-container text-on-warm-container',
  danger: 'bg-error-container text-on-error-container',
};

export function Pill({ tone = 'neutral', dot = false, className, children, ...rest }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-label-small whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span className="size-1.5 animate-blink rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}
