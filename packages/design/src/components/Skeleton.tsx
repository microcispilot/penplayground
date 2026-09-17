import { cn } from '../cn.js';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-[var(--radius-sm)] bg-surface-2', className)}
    />
  );
}
