import { cn } from '../cn.js';

export interface ProgressBarProps {
  /** 0–1 */
  value: number;
  label?: string;
  className?: string;
}

export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="progressbar"
      aria-labelledby={undefined}
      title={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('h-0.5 w-full overflow-hidden rounded-full bg-surface-2', className)}
    >
      <div
        className="h-full bg-accent transition-[width] duration-[var(--duration-scene)] ease-[var(--ease-out)]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export interface SegmentDotsProps {
  total: number;
  /** Number of segments completed. */
  done: number;
  active?: number;
  className?: string;
}

/** The progress dots in the room's bottom bar: one per lesson segment. */
export function SegmentDots({ total, done, active, className }: SegmentDotsProps) {
  return (
    <div
      role="img"
      className={cn('flex items-center gap-[3px]', className)}
      aria-label={`Step ${Math.min(done + 1, total)} of ${total}`}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: dots are positional by definition (segment i)
          key={i}
          className={cn(
            'h-1 rounded-sm transition-colors duration-[var(--duration-slow)]',
            i < done ? 'bg-accent' : i === active ? 'bg-accent/50' : 'bg-line-strong',
          )}
          style={{ width: 'clamp(5px, calc((100vw - 640px) / 12), 14px)' }}
        />
      ))}
    </div>
  );
}
