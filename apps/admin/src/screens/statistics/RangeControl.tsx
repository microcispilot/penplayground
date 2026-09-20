import { Chip, IconButton } from '@pen/design';
import { RefreshCw } from 'lucide-react';
import { dayLabel } from '../../lib/format.js';
import {
  BUCKETS,
  type Bucket,
  describeRange,
  MAX_WINDOW_DAYS,
  RANGES,
  toIsoDate,
} from '../../lib/range.js';
import type { RangeController } from './use-range.js';

const BUCKET_LABELS: Record<Bucket, string> = {
  hour: 'by hour',
  day: 'by day',
  week: 'by week',
  month: 'by month',
};

/**
 * The one control every statistics page reads from (ADR-0027).
 *
 * Presets first, because "the last thirty days" is what is actually asked
 * nine times in ten and it is the API's own default. The custom pair is
 * there for the tenth, and it is two dates rather than a calendar widget:
 * the endpoints take whole UTC days and a date input is the control every
 * browser already draws well, in both themes, at every width.
 *
 * The resolved window is printed underneath in words. A range control that
 * shows "90 days" and nothing else leaves the reader to work out which
 * ninety, and every number on the page depends on the answer.
 */
export function RangeControl({
  controller,
  showBucket = false,
}: {
  controller: RangeController;
  showBucket?: boolean;
}) {
  const { range, choice, set } = controller;
  const custom = range.presetId === 'custom';
  // The custom inputs open on the window currently in force, so switching to
  // them is a nudge rather than a blank form.
  const fromDate = choice.fromDate ?? toIsoDate(range.from);
  const toDate = choice.toDate ?? toIsoDate(range.to - 1);

  return (
    <div className="flex flex-col gap-2" data-testid="range-control">
      <div className="flex flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; these are a run of chips that change a query string, and role="group" with a name is the ARIA pattern for that */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Date range">
          {RANGES.map((preset) => (
            <Chip
              key={preset.id}
              selected={range.presetId === preset.id}
              onClick={() =>
                set({ presetId: preset.id, ...(choice.bucket ? { bucket: choice.bucket } : {}) })
              }
              data-testid={`range-${preset.id}`}
            >
              {preset.label}
            </Chip>
          ))}
          <Chip
            selected={custom}
            onClick={() =>
              set({
                presetId: 'custom',
                fromDate,
                toDate,
                ...(choice.bucket ? { bucket: choice.bucket } : {}),
              })
            }
            data-testid="range-custom"
          >
            Custom
          </Chip>
        </div>

        {custom ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-label-medium text-on-surface-variant">
              <span>From</span>
              <input
                type="date"
                value={fromDate}
                max={toDate}
                onChange={(e) =>
                  set({ ...choice, presetId: 'custom', fromDate: e.target.value, toDate })
                }
                className="h-8 rounded-xs border border-outline bg-surface px-2 text-body-small text-on-surface focus-visible:border-primary"
                data-testid="range-from"
              />
            </label>
            <label className="flex items-center gap-1.5 text-label-medium text-on-surface-variant">
              <span>to</span>
              <input
                type="date"
                value={toDate}
                min={fromDate}
                onChange={(e) =>
                  set({ ...choice, presetId: 'custom', fromDate, toDate: e.target.value })
                }
                className="h-8 rounded-xs border border-outline bg-surface px-2 text-body-small text-on-surface focus-visible:border-primary"
                data-testid="range-to"
              />
            </label>
          </div>
        ) : null}

        {showBucket ? (
          <label className="flex items-center gap-1.5 text-label-medium text-on-surface-variant">
            <span className="sr-only">Group</span>
            <select
              value={range.bucket}
              onChange={(e) => set({ ...choice, bucket: e.target.value as Bucket })}
              className="h-8 rounded-xs border border-outline bg-surface px-2 text-body-small text-on-surface focus-visible:border-primary"
              data-testid="range-bucket"
            >
              {BUCKETS.map((bucket) => (
                <option key={bucket} value={bucket}>
                  {BUCKET_LABELS[bucket]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <IconButton
          label="Read the reports again"
          onClick={controller.refresh}
          data-testid="range-refresh"
        >
          <RefreshCw size={16} aria-hidden />
        </IconButton>
      </div>

      <p className="text-body-small text-on-surface-dim" data-testid="range-summary">
        {describeRange(range, dayLabel)}
        {range.clamped
          ? ` — the server answers for at most ${MAX_WINDOW_DAYS} days, so this window is trimmed to its most recent ${MAX_WINDOW_DAYS}.`
          : ''}
      </p>
    </div>
  );
}
