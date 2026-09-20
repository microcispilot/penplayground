import { cn } from '@pen/design';
import { laneSegments, rampOpacity } from './geometry.js';

/**
 * The console's one ordered ramp, and the reason there is no palette here.
 *
 * Every chart in this app draws in the brand and nothing else, at varying
 * weight. A categorical palette would need four or five hues that are all
 * legible on a chroma-0 neutral in both themes and that mean nothing — and
 * this design system deliberately has no such hues: the ones it does have
 * (`presence`, `warm`, `success`, `error`) each carry a meaning, and
 * borrowing them to mean "yearly subscribers" would say something untrue on
 * the one page where being untrue matters most.
 *
 * Columns take their weights as classes, because two or three series is all
 * a stacked column can carry. A lane can carry six, so it ramps by opacity
 * (`rampOpacity`) — the same one token, spread across however many parts
 * there turn out to be.
 */
export const RAMP_FILL = [
  'fill-primary/80',
  'fill-primary/55',
  'fill-primary/30',
  'fill-outline-variant',
] as const;

export interface LanePart {
  key: string;
  label: string;
  value: number;
}

/**
 * One horizontal bar split between a handful of parts, with a legend that
 * carries the numbers.
 *
 * Used for a mix — plan against plan, signed-in against anonymous — where the
 * shares matter and the total is written above. Segments below a pixel are
 * dropped by `laneSegments` rather than drawn as invisible slivers with a
 * legend row of their own.
 */
export function StackedLane({
  parts,
  format,
  emptyLabel,
  className,
}: {
  parts: readonly LanePart[];
  format: (value: number) => string;
  emptyLabel: string;
  className?: string;
}) {
  const segments = laneSegments(parts);
  if (segments.length === 0)
    return (
      <p className="rounded-sm bg-surface-container px-4 py-6 text-center text-body-medium text-on-surface-variant">
        {emptyLabel}
      </p>
    );
  const byKey = new Map(parts.map((p) => [p.key, p]));
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-container-high">
        {segments.map((segment, i) => (
          <span
            key={segment.key}
            title={`${byKey.get(segment.key)?.label ?? segment.key} — ${format(segment.value)}`}
            className="bg-primary"
            style={{ width: `${segment.percent}%`, opacity: rampOpacity(i, segments.length) }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((segment, i) => (
          <li key={segment.key} className="inline-flex items-center gap-2 text-body-medium">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-primary"
              style={{ opacity: rampOpacity(i, segments.length) }}
            />
            <span className="text-on-surface-variant">
              {byKey.get(segment.key)?.label ?? segment.key}
            </span>
            <span className="text-on-surface tabular">{format(segment.value)}</span>
            <span className="text-on-surface-dim tabular">{segment.percent}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
