import { cn } from '../cn.js';

export interface ProgressBarProps {
  /** 0–1 */
  value: number;
  label?: string;
  className?: string;
}

/**
 * M3's linear progress indicator: a 4 px `corner-full` track in
 * `secondary-container` with a `primary` indicator running across it.
 * (@material/web tokens/versions/v0_192/_md-comp-linear-progress.scss)
 */
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
      // The track is neutral, not `secondary-container`: that role carries the
      // brand now, and a red fill on a red track is one bar with no reading.
      className={cn(
        'h-1 w-full overflow-hidden rounded-full bg-surface-container-highest',
        className,
      )}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-[var(--duration-scene)] ease-[var(--ease-out)]"
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
            'h-1 rounded-full transition-colors duration-[var(--duration-slow)]',
            i < done ? 'bg-primary' : i === active ? 'bg-primary/50' : 'bg-outline-variant',
          )}
          style={{ width: 'clamp(5px, calc((100vw - 640px) / 12), 14px)' }}
        />
      ))}
    </div>
  );
}
