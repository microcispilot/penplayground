import { cn } from '@pen/design';
import type { ReactNode } from 'react';

export interface BarRow {
  key: string;
  label: ReactNode;
  /** What the bar is drawn to, and what is printed on the right. */
  value: number;
  /** A second, quieter number for the same row: "4,112 visits · 38 % bounced". */
  note?: ReactNode;
}

/**
 * A ranked split, drawn as a wash behind each row rather than as a bar beside
 * it.
 *
 * This is the shape almost every "by something" answer in the console takes —
 * by plan, by expert, by screen, by country, by device, by error code — and
 * it is the one that needs no palette at all: a single brand wash, scaled to
 * the largest row, with the label on top of it. Nine rows read as easily as
 * three, which a pie or a nine-way stack does not.
 */
export function BarList({
  rows,
  format,
  emptyLabel,
  className,
  max,
}: {
  rows: readonly BarRow[];
  format: (value: number) => string;
  /** What to say when there is nothing. Never "no data". */
  emptyLabel: string;
  className?: string;
  /** Force the scale, so two lists beside each other compare honestly. */
  max?: number;
}) {
  if (rows.length === 0)
    return (
      // The same calm box every empty state in the console uses, so a page
      // with one populated card and one empty one still reads as one page.
      <p className="rounded-sm bg-surface-container px-4 py-6 text-center text-body-medium text-on-surface-variant">
        {emptyLabel}
      </p>
    );
  const peak = max ?? Math.max(...rows.map((r) => (Number.isFinite(r.value) ? r.value : 0)), 0);
  return (
    <ul className={cn('flex flex-col gap-px', className)}>
      {rows.map((row) => {
        const width = peak > 0 && row.value > 0 ? Math.max((row.value / peak) * 100, 1.5) : 0;
        return (
          <li
            key={row.key}
            className="relative isolate flex items-center gap-3 rounded-xs px-2 py-1.5"
          >
            <span
              aria-hidden
              className="-z-10 absolute inset-y-0 start-0 rounded-xs bg-primary/14"
              style={{ width: `${width}%` }}
            />
            <span className="min-w-0 flex-1 truncate text-body-medium text-on-surface">
              {row.label}
            </span>
            {row.note ? (
              <span className="shrink-0 text-label-small text-on-surface-dim tabular">
                {row.note}
              </span>
            ) : null}
            <span className="shrink-0 text-body-medium text-on-surface tabular">
              {format(row.value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
