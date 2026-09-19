import { cn } from '@pen/design';
import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from 'react';
import { formatClock } from '../lib/context.js';
import type { ReplayChapter } from '../room/replay-timeline.js';

export interface ReplayScrubberProps {
  /** Recorded position, ms. */
  positionMs: number;
  /** Total recorded length, ms. */
  totalMs: number;
  /** How much has been fetched, ms. */
  bufferedMs: number;
  chapters: readonly ReplayChapter[];
  /** Commit a seek (drag released, tick clicked, key pressed). */
  onSeek: (ms: number) => void;
  /** Live feedback while dragging, before the seek is committed. */
  onScrub?: (ms: number) => void;
  disabled?: boolean;
  className?: string;
}

/** Keyboard step sizes, matching what a video player has taught everyone. */
export const ARROW_STEP_MS = 5_000;
export const JL_STEP_MS = 10_000;

function pct(value: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

/**
 * The replay timeline: played, buffered, a tick per lesson segment, drag to
 * seek, and a tooltip that names the segment under the pointer.
 *
 * It is a real `slider` for assistive technology — the value is the recorded
 * position in seconds and `aria-valuetext` reads it as a clock — so the
 * keyboard story is the platform's, not a bespoke one.
 */
export function ReplayScrubber({
  positionMs,
  totalMs,
  bufferedMs,
  chapters,
  onSeek,
  onScrub,
  disabled = false,
  className,
}: ReplayScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const shown = dragMs ?? positionMs;
  const tipMs = dragMs ?? hoverMs;

  const msAt = useCallback(
    (clientX: number): number => {
      const box = trackRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return 0;
      const ratio = (clientX - box.left) / box.width;
      return Math.round(Math.max(0, Math.min(1, ratio)) * totalMs);
    },
    [totalMs],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ms = msAt(e.clientX);
    setDragMs(ms);
    onScrub?.(ms);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const ms = msAt(e.clientX);
    setHoverMs(ms);
    if (dragMs === null) return;
    setDragMs(ms);
    onScrub?.(ms);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || dragMs === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const ms = msAt(e.clientX);
    setDragMs(null);
    onSeek(ms);
  };

  const step = (delta: number) => {
    onSeek(Math.max(0, Math.min(totalMs, positionMs + delta)));
  };

  const tipChapter = tipMs === null ? null : chapterAt(chapters, tipMs);

  return (
    <div className={cn('relative w-full', className)} data-testid="replay-scrubber">
      {tipMs !== null && !disabled ? (
        <div
          className="pointer-events-none absolute bottom-[calc(100%+10px)] z-[10] -translate-x-1/2 whitespace-nowrap rounded-sm bg-on-surface px-2 py-1 text-label-small text-surface shadow-level3"
          style={{ left: `${pct(tipMs, totalMs)}%` }}
          data-testid="scrubber-tooltip"
        >
          <span className="tabular">{formatClock(tipMs)}</span>
          {tipChapter ? <span className="opacity-70"> · {tipChapter.title}</span> : null}
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/useSemanticElements: a range input cannot carry chapter ticks or a buffered fill */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalMs / 1000)}
        aria-valuenow={Math.round(shown / 1000)}
        aria-valuetext={`${formatClock(shown)} of ${formatClock(totalMs)}`}
        aria-disabled={disabled || undefined}
        data-testid="scrubber-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverMs(null)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            step(ARROW_STEP_MS);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            step(-ARROW_STEP_MS);
          } else if (e.key === 'Home') {
            e.preventDefault();
            onSeek(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            onSeek(totalMs);
          }
        }}
        className={cn(
          'group relative flex h-5 w-full cursor-pointer touch-none items-center focus-visible:outline-primary',
          disabled && 'cursor-default opacity-50',
        )}
      >
        {/*
          M3's slider: a 4 px `corner-full` track, inactive in
          `surface-container-highest`, active in `primary`, with a `primary`
          handle. (@material/web tokens/versions/v0_192/_md-comp-slider.scss)
          The handle is 12 px rather than M3's 20: this scrubber sits in a
          20 px row under the board, and a 20 px knob would be taller than
          the row it lives in.
        */}
        <div className="relative h-1 w-full rounded-full bg-surface-container-highest">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-outline/45"
            style={{ width: `${pct(bufferedMs, totalMs)}%` }}
            data-testid="scrubber-buffered"
          />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${pct(shown, totalMs)}%` }}
            data-testid="scrubber-played"
          />
          {chapters.map((c) =>
            c.startMs <= 0 ? null : (
              <span
                key={c.segment}
                aria-hidden
                title={c.title}
                className="absolute top-[-1px] h-[6px] w-[2px] rounded-full bg-on-primary/80"
                style={{ left: `${pct(c.startMs, totalMs)}%` }}
                data-testid="scrubber-tick"
              />
            ),
          )}
          <span
            aria-hidden
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-level1 transition-transform duration-[var(--duration-fast)] group-hover:scale-125"
            style={{ left: `${pct(shown, totalMs)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function chapterAt(chapters: readonly ReplayChapter[], ms: number): ReplayChapter | null {
  let found: ReplayChapter | null = null;
  for (const c of chapters) {
    if (c.startMs <= ms) found = c;
    else break;
  }
  return found;
}
