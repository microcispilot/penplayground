import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'rounded-xs bg-surface-container-high px-1.5 py-0.5 font-mono text-label-small text-on-surface-variant hairline',
        className,
      )}
      {...rest}
    />
  );
}
