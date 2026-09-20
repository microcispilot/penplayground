import { cn } from '@pen/design';
import { heatIntensity } from './geometry.js';

export interface HeatCell {
  /** Null means the cell does not exist yet — a cohort younger than the column. */
  value: number | null;
  /** What a hover, and a screen reader, are told. */
  title: string;
  /** What is printed inside the cell, where anything is. */
  text?: string;
}

/**
 * A grid of cells shaded by value: the retention cohort grid and the
 * hour-of-day clock are the same picture with different axes, so they are the
 * same component.
 *
 * It is a real `<table>`, not an SVG. A cohort grid *is* tabular — row
 * headers, column headers, a number in each cell — and a screen reader that
 * can walk it by row and column reads it better than any caption could. The
 * shading is one brand wash at varying opacity (`heatIntensity`), so the grid
 * needs no scale of its own and stays legible in both themes.
 */
export function HeatGrid({
  caption,
  columnLabels,
  rows,
  max,
  className,
  cellMinWidth = 40,
}: {
  caption: string;
  columnLabels: readonly string[];
  rows: readonly { label: string; note?: string; cells: readonly HeatCell[] }[];
  /** The value a fully-saturated cell holds. */
  max: number;
  className?: string;
  cellMinWidth?: number;
}) {
  return (
    <div className={cn('-mx-1 overflow-x-auto px-1', className)}>
      <table className="w-full border-separate border-spacing-0.5 text-label-small">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky start-0 bg-surface-container-low pe-2 text-start font-normal text-on-surface-dim"
            >
              <span className="sr-only">Row</span>
            </th>
            {columnLabels.map((label, i) => (
              <th
                // Keyed by position, not by text: a clock grid labels only
                // every third hour, so most of these strings are empty and
                // identical.
                // biome-ignore lint/suspicious/noArrayIndexKey: the columns are a fixed run of positions, and their labels are deliberately not unique
                key={i}
                scope="col"
                className="px-1 pb-1 text-center font-normal text-on-surface-dim whitespace-nowrap"
                style={{ minWidth: cellMinWidth }}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th
                scope="row"
                className="sticky start-0 bg-surface-container-low pe-2 text-start font-normal text-on-surface-variant whitespace-nowrap"
              >
                {row.label}
                {row.note ? <span className="ms-1.5 text-on-surface-dim">{row.note}</span> : null}
              </th>
              {row.cells.map((cell, i) => {
                const intensity = cell.value === null ? 0 : heatIntensity(cell.value, max);
                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: same — one cell per column position, and column labels repeat
                    key={`${row.label}-${i}`}
                    title={cell.title}
                    className={cn(
                      'relative isolate h-7 rounded-xs text-center tabular',
                      cell.value === null
                        ? 'text-transparent'
                        : intensity > 0.62
                          ? 'text-on-primary'
                          : 'text-on-surface',
                    )}
                    style={{ minWidth: cellMinWidth }}
                  >
                    {cell.value === null ? null : (
                      <span
                        aria-hidden
                        className="-z-10 absolute inset-0 rounded-xs bg-primary"
                        style={{ opacity: intensity }}
                      />
                    )}
                    {cell.value === null ? (
                      <span className="sr-only">not yet</span>
                    ) : (
                      (cell.text ?? '')
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
