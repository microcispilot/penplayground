import { Button, cn, Skeleton } from '@pen/design';
import type { ReactNode } from 'react';
import type { ReportState } from './use-report.js';

/**
 * The furniture every statistics page is built from.
 *
 * Kept in one file on purpose: these are the decisions that have to be the
 * same on all seven pages — how a section is titled, how a number is set, what
 * a page says when it is loading, when it failed, and when the honest answer
 * is zero. A page that invents its own version of any of those is the way a
 * console stops looking like one product.
 *
 * Type stays small throughout (the owner's constraint): `title-large` is the
 * biggest thing below a page heading, section headings are `title-medium`,
 * copy is `body-medium`, and chrome is `label-*`. Numbers are
 * `title-medium`, not a display role — a big number is not a more important
 * number, it is just a louder one.
 */

export function Section({
  title,
  note,
  actions,
  children,
  className,
  id,
}: {
  title: string;
  /** One quiet sentence under the heading: what the number means, or what it does not. */
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ?? `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn('rounded-md bg-surface-container-low p-5 hairline', className)}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-title-medium text-on-surface">
            {title}
          </h2>
          {note ? (
            <p className="mt-1 max-w-[70ch] text-body-small text-on-surface-variant">{note}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One headline number. The label sits above it because the label is what the
 * eye needs first on a page of twenty of them, and the note below carries the
 * caveat — "of 1,240 sessions", "no audio ever played in 3".
 */
export function StatTile({
  label,
  value,
  note,
  children,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  /** A sparkline, or anything else that belongs under the number. */
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-sm bg-surface-container-low p-4 hairline">
      <span className="text-label-medium text-on-surface-variant">{label}</span>
      <span className="text-title-medium text-on-surface tabular">{value}</span>
      {note ? <span className="text-body-small text-on-surface-dim">{note}</span> : null}
      {children}
    </div>
  );
}

/** A responsive run of tiles: four across on a desktop, two on a tablet, one on a phone. */
export function TileRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}
      data-testid="stat-tiles"
    >
      {children}
    </div>
  );
}

/**
 * What a page says when there is nothing to show.
 *
 * Never "no data" and never an alarm. A fresh deployment has no sessions in
 * it, and that is not a fault — so the sentence says what would put something
 * here, and the page keeps its shape around it.
 */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-sm bg-surface-container px-4 py-6 text-center text-body-medium text-on-surface-variant">
      {children}
    </p>
  );
}

/** The one-line definition under a number that would otherwise be misread. */
export function Caveat({ children }: { children: ReactNode }) {
  return <p className="max-w-[80ch] text-body-small text-on-surface-dim">{children}</p>;
}

/**
 * A report's three states, in one place.
 *
 * The skeleton is only ever shown for a *first* load. Once there is an
 * answer on screen a refresh dims it instead, because a chart that vanishes
 * every time the range moves is the "silent and still" the product bar
 * forbids.
 */
export function ReportBody<T>({
  state,
  skeleton,
  children,
}: {
  state: ReportState<T>;
  /** What the shape of the answer looks like before it arrives. */
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.error && state.data === null)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-error-container p-4 text-body-medium text-on-error-container"
        data-testid="report-error"
      >
        <span>{state.error}</span>
        <Button variant="secondary" size="sm" onClick={state.reload}>
          Try again
        </Button>
      </div>
    );
  if (state.data === null)
    return (
      <div data-testid="report-loading" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading</span>
        {skeleton ?? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
      </div>
    );
  return (
    <div
      data-testid="report-body"
      className={cn(
        'flex flex-col gap-4 transition-opacity duration-[var(--duration-base)]',
        state.refreshing && 'opacity-60',
      )}
    >
      {state.error ? (
        <p
          role="alert"
          className="rounded-sm bg-error-container px-4 py-3 text-body-small text-on-error-container"
        >
          {state.error} These are the numbers from before that failed.
        </p>
      ) : null}
      {children(state.data)}
    </div>
  );
}

// ── tables ───────────────────────────────────────────────────────────────────

/**
 * Every table in the console scrolls inside its own box rather than pushing
 * the page sideways — the product bar's tablet and phone widths, kept without
 * hiding a column anyone might need.
 */
export function TableFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('-mx-1 overflow-x-auto px-1', className)}>
      <table className="w-full min-w-[34rem] border-collapse text-body-medium">{children}</table>
    </div>
  );
}

export function Th({
  children,
  numeric = false,
  className,
  scope = 'col',
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
  scope?: 'col' | 'row';
}) {
  return (
    <th
      scope={scope}
      className={cn(
        'border-outline-variant border-b px-2 py-2 text-label-medium font-medium text-on-surface-variant',
        numeric ? 'text-end' : 'text-start',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric = false,
  className,
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-outline-variant/60 border-b px-2 py-2 text-on-surface',
        // A numeric cell never wraps: "12m 22s" broken over two lines makes
        // every row in the table a different height, and the table already
        // scrolls inside its own frame when it needs the room.
        numeric ? 'text-end tabular whitespace-nowrap' : 'text-start',
        className,
      )}
    >
      {children}
    </td>
  );
}
