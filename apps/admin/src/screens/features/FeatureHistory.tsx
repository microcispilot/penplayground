import type { FeatureFlagsHistoryEntry, FeatureRule } from '@pen/contracts';
import { FEATURES, isFeatureName, PLAN_NAME, PLATFORM_LABEL } from '@pen/contracts';
import { Button, Card } from '@pen/design';
import { showMoment } from '../../lib/presenters.js';

/** A rule in a sentence, for the history: what it decides beyond its default. */
export function describeRule(rule: FeatureRule): string {
  const parts: string[] = [`default ${rule.default ? 'on' : 'off'}`];
  for (const [plan, on] of Object.entries(rule.plans))
    if (typeof on === 'boolean')
      parts.push(`${PLAN_NAME[plan as keyof typeof PLAN_NAME] ?? plan} ${on ? 'on' : 'off'}`);
  for (const [platform, on] of Object.entries(rule.platforms))
    if (typeof on === 'boolean')
      parts.push(
        `${PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL] ?? platform} ${on ? 'on' : 'off'}`,
      );
  for (const [cell, on] of Object.entries(rule.cells))
    if (typeof on === 'boolean') {
      const [plan, platform] = cell.split(':');
      parts.push(
        `${PLAN_NAME[plan as keyof typeof PLAN_NAME] ?? plan} on ${PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL] ?? platform} ${on ? 'on' : 'off'}`,
      );
    }
  return parts.join(' · ');
}

/**
 * Every revision of the feature flags, newest first, with who changed what
 * and why (ADR-0036). The same shape as the settings history: a rollback is
 * offered per entry and saves that revision again as a new one.
 */
export function FeatureHistory({
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
  entries: readonly FeatureFlagsHistoryEntry[];
  currentRevision: number;
  loading: boolean;
  error: string | null;
  nextBeforeRevision: number | null;
  canRestore: boolean;
  onRestore: (entry: FeatureFlagsHistoryEntry) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  return (
    <section aria-labelledby="features-history-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="features-history-title" className="text-title-large text-on-surface">
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
        <Card
          className="p-5 text-body-medium text-on-surface-variant"
          data-testid="features-history-empty"
        >
          Nothing has been changed yet. Every feature follows its built-in rule.
        </Card>
      ) : null}

      {entries.map((entry) => {
        const when = showMoment(entry.updatedAt);
        const names = Object.keys(entry.rules).sort();
        return (
          <Card
            key={entry.revision}
            className="p-0"
            data-testid={`features-revision-${entry.revision}`}
          >
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
                    Every feature at its built-in rule.
                  </p>
                ) : (
                  <ul className="divide-y divide-outline-variant rounded-sm bg-surface-container">
                    {names.map((name) => {
                      const rule = entry.rules[name as keyof typeof entry.rules];
                      return (
                        <li
                          key={name}
                          className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-body-medium"
                        >
                          <span className="text-on-surface">
                            {isFeatureName(name) ? FEATURES[name].label : name}
                          </span>
                          <span className="text-on-surface-variant">
                            {rule ? describeRule(rule) : ''}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      !canRestore || loading || error !== null || entry.revision >= currentRevision
                    }
                    aria-label={`Restore feature revision ${entry.revision}`}
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
