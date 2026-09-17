import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-2 hairline',
        className,
      )}
      {...rest}
    />
  );
}
