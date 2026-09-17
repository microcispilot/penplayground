import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type PillTone = 'neutral' | 'live' | 'accent' | 'warm' | 'danger';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  dot?: boolean;
}

const tones: Record<PillTone, string> = {
  neutral: 'bg-surface-2 text-fg-2',
  live: 'bg-presence-soft text-presence',
  accent: 'bg-accent-soft text-accent-strong',
  warm: 'bg-warm-soft text-warm',
  danger: 'bg-danger-soft text-danger',
};

export function Pill({ tone = 'neutral', dot = false, className, children, ...rest }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium',
        tones[tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current animate-blink" aria-hidden /> : null}
      {children}
    </span>
  );
}
