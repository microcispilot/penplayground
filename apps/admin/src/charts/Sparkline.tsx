import { cn } from '@pen/design';
import { extentOf, linePath } from './geometry.js';

/**
 * One series over time, at the size of a line of text.
 *
 * Drawn in an abstract 100 × `height` box and stretched to whatever width it
 * is given (`preserveAspectRatio="none"`), which is why the stroke carries
 * `vector-effect="non-scaling-stroke"` — without it the line thins to nothing
 * on a wide card and thickens on a narrow one.
 *
 * It is a picture, so it is `role="img"` with a sentence rather than a pile
 * of unreadable `<rect>`s; the numbers themselves are always printed beside
 * it on the page, never only here.
 */
export function Sparkline({
  values,
  label,
  className,
  height = 40,
}: {
  values: readonly number[];
  /** The sentence a screen reader hears in place of the picture. */
  label: string;
  className?: string;
  height?: number;
}) {
  const extent = extentOf(values);
  const shape = linePath(values, 100, height, extent);
  const empty = values.length === 0 || values.every((v) => !v);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={cn('w-full', className)}
      style={{ height }}
    >
      {empty ? (
        // A flat rule on the floor: an empty series is a real answer, and a
        // blank box reads as a chart that failed to load.
        <line
          x1="0"
          y1={height - 0.5}
          x2="100"
          y2={height - 0.5}
          className="stroke-outline-variant"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <>
          <path d={shape.area} className="fill-primary/12" />
          <path
            d={shape.line}
            fill="none"
            className="stroke-primary"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}
