import { cn } from '@pen/design';
import { columnLayout, gapFor, labelStride, niceMax } from './geometry.js';

export interface ColumnSeries {
  key: string;
  label: string;
  /** A `fill-*` utility from the design system. Never a colour of its own. */
  fill: string;
}

export interface ColumnPoint {
  label: string;
  /** One value per series, in the same order as `series`. */
  values: number[];
}

/**
 * A run of columns over time, stacked where there is more than one series.
 *
 * At most two or three series: this console's charts answer one question
 * each, and a seven-way stack answers none of them. Where a split has more
 * parts than that it is drawn as a `BarList` instead, which stays readable
 * at any number of rows and needs no palette.
 *
 * Each column carries a `<title>`, so the exact numbers are a hover away
 * without a tooltip layer, and the whole figure carries a caption for anyone
 * who cannot see it.
 */
export function Columns({
  points,
  series,
  format,
  label,
  height = 132,
  className,
}: {
  points: readonly ColumnPoint[];
  series: readonly ColumnSeries[];
  /** How a value reads in the hover title and on the axis. */
  format: (value: number) => string;
  label: string;
  height?: number;
  className?: string;
}) {
  const rows = points.map((p) => p.values);
  const peak = Math.max(0, ...rows.map((r) => r.reduce((a, b) => a + (b > 0 ? b : 0), 0)));
  const axisTop = niceMax(peak);
  const { columns } = columnLayout(rows, 100, height, {
    max: axisTop || 1,
    gapRatio: gapFor(points.length),
  });
  const ticks = labelStride(points.length, 7);
  const empty = peak === 0;

  return (
    <figure className={cn('m-0 flex flex-col gap-2', className)}>
      <div className="flex items-stretch gap-2">
        <div
          className="flex w-14 shrink-0 flex-col justify-between text-right text-label-small text-on-surface-dim tabular"
          aria-hidden
        >
          <span>{empty ? '' : format(axisTop)}</span>
          <span>{empty ? '' : format(0)}</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <svg
            role="img"
            aria-label={label}
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            className="w-full"
            style={{ height }}
          >
            {empty ? null : (
              <line
                x1="0"
                y1="0.5"
                x2="100"
                y2="0.5"
                className="stroke-outline-variant"
                strokeWidth="1"
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {columns.map((column) => (
              <g key={points[column.index]?.label ?? column.index}>
                <title>
                  {`${points[column.index]?.label ?? ''} — ${
                    series.length === 1
                      ? format(column.total)
                      : series
                          .map(
                            (s, i) => `${s.label} ${format(points[column.index]?.values[i] ?? 0)}`,
                          )
                          .join(', ')
                  }`}
                </title>
                {column.parts.map((part) => (
                  <rect
                    key={series[part.series]?.key ?? part.series}
                    x={column.x}
                    y={part.y}
                    width={column.width}
                    height={Math.max(part.height, 0.5)}
                    className={series[part.series]?.fill ?? 'fill-primary'}
                  />
                ))}
              </g>
            ))}
          </svg>
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 border-outline-variant border-t"
            aria-hidden
          />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="w-14 shrink-0" aria-hidden />
        <div className="relative h-4 min-w-0 flex-1" aria-hidden>
          {ticks.map((i) => (
            <span
              key={i}
              // Every other label is dropped on a narrow screen rather than
              // letting "20 Aug" and "25 Aug" collide: the first and last are
              // odd-numbered children, so both always survive.
              className="-translate-x-1/2 absolute top-0 text-label-small text-on-surface-dim whitespace-nowrap max-sm:even:hidden"
              style={{ left: `${points.length === 1 ? 50 : (i / (points.length - 1)) * 100}%` }}
            >
              {points[i]?.label ?? ''}
            </span>
          ))}
        </div>
      </div>
      {series.length > 1 ? (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 ps-16 text-label-small text-on-surface-variant">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <svg width="8" height="8" aria-hidden className="shrink-0">
                <rect width="8" height="8" rx="2" className={s.fill} />
              </svg>
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}
