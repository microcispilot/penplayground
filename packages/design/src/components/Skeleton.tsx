import { cn } from '../cn.js';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-sm bg-surface-container-high', className)}
    />
  );
}
