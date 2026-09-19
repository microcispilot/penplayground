import type { RuntimeConfigHistoryEntry } from '@pen/contracts';
import { Button, Card } from '@pen/design';
import { showMoment, showValue } from '../../lib/presenters.js';

/**
 * Everything that was ever in force, newest first (ADR-0026). A revision is
 * never rewritten and never removed, so this is the record of how the product
 * came to behave the way it does — and restoring one writes a new revision
 * rather than erasing the ones after it.
 */
export function RevisionHistory({
  entries,
  currentRevision,
  loading,
  error,
  nextBeforeRevision,
  canRestore,
  onRestore,
  onRefresh,
  onLoadMore,
}: {
  entries: readonly RuntimeConfigHistoryEntry[];
  currentRevision: number;
  loading: boolean;
  error: string | null;
  nextBeforeRevision: number | null;
  canRestore: boolean;
  onRestore: (entry: RuntimeConfigHistoryEntry) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  return (
    <section aria-labelledby="history-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="history-title" className="text-title-large text-on-surface">
            History
          </h2>
          <p className="mt-1 max-w-[62ch] text-body-medium text-on-surface-variant">
            Every change, with who made it and why. Restoring an old revision saves it again as a
            new one, so nothing here is ever lost.
          </p>
        </div>
        <Button variant="secondary" size="sm" disabled={loading} onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-sm bg-error-container p-4 text-body-medium text-on-error-container"
        >
          {error}
        </p>
      ) : null}

      {entries.length === 0 && !loading && !error ? (
        <Card className="p-5 text-body-medium text-on-surface-variant" data-testid="history-empty">
          Nothing has been changed yet. Every setting is at its default.
        </Card>
      ) : null}

      {entries.map((entry) => {
        const when = showMoment(entry.updatedAt);
        const names = Object.keys(entry.settings).sort();
        return (
          <Card key={entry.revision} className="p-0" data-testid={`revision-${entry.revision}`}>
            <details className="group">
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-md p-5 text-body-medium text-on-surface">
                <span className="text-title-small">Revision {entry.revision}</span>
                {entry.revision === currentRevision ? (
                  <span className="text-on-surface-variant">· in force</span>
                ) : null}
                <span className="text-on-surface-variant">
                  · <time dateTime={when.iso}>{when.text}</time> · {entry.updatedByName}
                </span>
              </summary>
              <div className="flex flex-col gap-4 px-5 pb-5">
                <dl className="grid gap-3 text-body-medium sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <dt className="text-on-surface-variant">Reason</dt>
                  <dd className="whitespace-pre-wrap break-words text-on-surface">
                    {entry.reason}
                  </dd>
                  {entry.restoredFromRevision !== null ? (
                    <>
                      <dt className="text-on-surface-variant">Restored</dt>
                      <dd className="text-on-surface">revision {entry.restoredFromRevision}</dd>
                    </>
                  ) : null}
                </dl>
                {names.length === 0 ? (
                  <p className="text-body-medium text-on-surface-variant">
                    Everything at its default.
                  </p>
                ) : (
                  <ul className="divide-y divide-outline-variant rounded-sm bg-surface-container">
                    {names.map((name) => (
                      <li
                        key={name}
                        className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-body-medium"
                      >
                        <code className="font-mono text-on-surface-variant">{name}</code>
                        <strong className="text-on-surface">
                          {showValue(entry.settings[name] ?? null)}
                        </strong>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      !canRestore || loading || error !== null || entry.revision >= currentRevision
                    }
                    aria-label={`Restore revision ${entry.revision}`}
                    onClick={() => onRestore(entry)}
                  >
                    Restore this revision
                  </Button>
                </div>
              </div>
            </details>
          </Card>
        );
      })}

      {loading ? (
        <p role="status" className="text-body-medium text-on-surface-variant">
          Reading the history…
        </p>
      ) : null}
      {nextBeforeRevision !== null ? (
        <div>
          <Button variant="secondary" disabled={loading} onClick={onLoadMore}>
            Show older revisions
          </Button>
        </div>
      ) : null}
    </section>
  );
}
