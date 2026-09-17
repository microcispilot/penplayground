import type { AdEndReason, AdEventName } from '@pen/contracts';
import { AD_RULES } from '@pen/contracts';
import { cn } from '@pen/design';
import { SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type AdPlayer,
  type AdPlayerView,
  createAdPlayer,
  hasUserActivation,
} from '../ads/ad-player.js';
import { loadIma } from '../ads/ima.js';

export interface VideoAdProps {
  ad: {
    adId: string;
    tagUrl: string;
    slot: 'boundary' | 'preparation';
    skippableAfterMs: number;
    durationMs: number;
  };
  locale?: string;
  onEvent: (name: AdEventName, props: Record<string, string | number | boolean>) => void;
  /** Every outcome resumes the lesson the same way (conductor `skipAd()`). */
  onEnd: (reason: AdEndReason) => void;
}

/**
 * YouTube-style in-stream ad over the board (ADR-0014). The IMA SDK renders
 * the creative into `containerRef`; we own everything around it: the label,
 * the countdown, the skip rule, the unmute affordance and the honest "why".
 */
export function VideoAd({ ad, locale, onEvent, onEnd }: VideoAdProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<AdPlayer | null>(null);
  const [view, setView] = useState<AdPlayerView | null>(null);
  // Callbacks change identity per render; the player is created once per ad id.
  const latest = useRef({ onEvent, onEnd });
  latest.current = { onEvent, onEnd };
  const { adId, tagUrl, slot, skippableAfterMs, durationMs } = ad;

  useEffect(() => {
    const frame = frameRef.current;
    const container = containerRef.current;
    const video = videoRef.current;
    if (!frame || !container || !video) return;
    const player = createAdPlayer({
      ad: { adId, tagUrl, slot, skippableAfterMs, durationMs },
      container,
      video,
      loadSdk: () => loadIma({ timeoutMs: AD_RULES.sdkLoadTimeoutMs }),
      size: () => ({ width: frame.clientWidth, height: frame.clientHeight }),
      canAutoplayWithSound: () => hasUserActivation(),
      ...(locale ? { locale } : {}),
      onView: setView,
      onEvent: (name, props) => latest.current.onEvent(name, props),
      onEnd: (reason) => latest.current.onEnd(reason),
    });
    playerRef.current = player;
    const ro =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => player.resize());
    ro?.observe(frame);
    return () => {
      ro?.disconnect();
      player.destroy();
      playerRef.current = null;
    };
    // One player per ad: only a new ad (new id/tag) recreates it.
  }, [adId, tagUrl, slot, skippableAfterMs, durationMs, locale]);

  const status = view?.status ?? 'loading';
  const skippable = view?.skippable ?? false;
  const skipIn = Math.max(1, Math.ceil((view?.skipInMs ?? ad.skippableAfterMs) / 1000));
  const remaining = Math.max(0, Math.ceil((view?.remainingMs ?? ad.durationMs) / 1000));
  const muted = view?.muted ?? false;
  const label = `Ad · ${view?.position ?? 1} of ${view?.total ?? 1}`;

  return (
    <div
      role="dialog"
      aria-label="Advertisement"
      data-testid="video-ad"
      data-status={status}
      className="absolute inset-0 z-[8] grid place-items-center bg-navy-900/85 px-4 backdrop-blur-[2px]"
    >
      <div className="flex w-[min(880px,94%)] animate-rise flex-col gap-3">
        <div
          ref={frameRef}
          className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-lg)] bg-black shadow-pop"
        >
          {/* Content element the SDK requires; it never plays anything of ours. */}
          <video
            ref={videoRef}
            muted
            playsInline
            className="absolute inset-0 size-full"
            tabIndex={-1}
          />
          {/* IMA renders the creative here; it must be the top-left overlay of the frame. */}
          <div ref={containerRef} className="absolute inset-0" />
          {status !== 'playing' ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="flex items-center gap-2 text-[13px] text-white/75">
                <span className="block size-[13px] animate-spin rounded-full border-2 border-white/25 border-t-white/85" />
                {status === 'ended' ? 'Back to the lesson…' : 'Loading ad…'}
              </div>
            </div>
          ) : null}
          <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2">
            {/* Controls sit on a dark video surface, so they use their own scrim rather than the paper tokens. */}
            <span className="inline-flex items-center rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white">
              {label}
            </span>
            {view?.title ? (
              <span className="max-w-[40vw] truncate text-[12px] text-white/80">{view.title}</span>
            ) : null}
          </div>
          <div className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white/90 tabular">
            {remaining}s
          </div>
          {muted && status === 'playing' ? (
            <button
              type="button"
              onClick={() => playerRef.current?.unmute()}
              className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/75"
            >
              <VolumeX size={14} /> Tap to unmute
            </button>
          ) : status === 'playing' ? (
            <span className="pointer-events-none absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs text-white/80">
              <Volume2 size={14} /> Sound on
            </span>
          ) : null}
          <button
            type="button"
            disabled={!skippable}
            onClick={() => playerRef.current?.skip()}
            className={cn(
              'absolute right-3 bottom-3 inline-flex h-9 min-w-[118px] select-none items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 text-sm font-medium tabular transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
              skippable
                ? 'bg-white text-black hover:bg-white/90 active:scale-[0.985]'
                : 'cursor-default bg-black/55 text-white/80 ring-1 ring-white/20',
            )}
            data-testid="skip-ad"
          >
            {skippable ? (
              <>
                Skip ad <SkipForward size={14} />
              </>
            ) : (
              `Skip in ${skipIn}`
            )}
          </button>
        </div>
        <div className="flex items-center justify-between text-xs text-white/70">
          <span>
            {ad.slot === 'preparation'
              ? 'Your session is being prepared.'
              : 'The lesson resumes right after.'}
          </span>
          <Link to="/pricing" className="underline-offset-2 hover:text-white hover:underline">
            Why ads? Standard removes them
          </Link>
        </div>
      </div>
    </div>
  );
}
