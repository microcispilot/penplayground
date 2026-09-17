import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-[var(--radius-lg)] bg-surface p-4 hairline', className)}
      {...rest}
    />
  );
}

export function Surface({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-[var(--radius-lg)] bg-bg-elevated shadow-card', className)}
      {...rest}
    />
  );
}
