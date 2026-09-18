import { Avatar, cn } from '@pen/design';
import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '../api/client.js';
import { formatDuration, useApp } from '../lib/context.js';
import { CardActions } from './ListControls.js';

/** Poll schedule while a fresh session's sketch is still being drawn (ADR-0013): ~2 minutes in total. */
const THUMB_POLL_MS = [3_000, 5_000, 8_000, 13_000, 21_000, 34_000, 40_000];
/** Older sessions with no thumbnail are not going to get one; do not poll for them. */
const THUMB_WATCH_WINDOW_MS = 30 * 60_000;

/**
 * The session's real thumbnail (the sketch the expert drew for it) over the
 * deterministic placeholder, which stays underneath until the image has
 * loaded so the card never flashes empty. With `watch`, a session that has
 * no sketch yet is polled on a slow back-off and upgrades in place — the
 * saved-session page right after "End" is the case that matters.
 * Positioning is the caller's (`absolute inset-0` inside a sized box, or
 * `relative` with a size), exactly like `BoardThumb`.
 */
export function SessionThumb({
  session,
  className,
  watch = false,
}: {
  session: Pick<SessionRecord, 'id' | 'thumbnail' | 'startedAt' | 'title'>;
  className?: string;
  /** Poll the record while the thumbnail is not ready (fresh sessions only). */
  watch?: boolean;
}) {
  const { api } = useApp();
  const [path, setPath] = useState<string | null>(session.thumbnail);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef(0);

  // A newer record (a list refresh, a parent poll) always wins over what we found ourselves.
  useEffect(() => {
    if (session.thumbnail) setPath(session.thumbnail);
  }, [session.thumbnail]);

  useEffect(() => {
    if (!watch || path || Date.now() - session.startedAt > THUMB_WATCH_WINDOW_MS) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const { session: fresh } = await api.getSession(session.id);
        if (cancelled) return;
        if (fresh.thumbnail) {
          setPath(fresh.thumbnail);
          return;
        }
      } catch {
        // A transient failure just waits for the next tick; the placeholder is a fine card.
      }
      const delay = THUMB_POLL_MS[attempt.current];
      attempt.current += 1;
      if (delay !== undefined && !cancelled) timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), THUMB_POLL_MS[0]);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, watch, path, session.id, session.startedAt]);

  const src = failed ? null : api.thumbnailUrl({ thumbnail: path });
  return (
    <div
      className={cn('overflow-hidden rounded-[var(--radius-md)]', className)}
      data-testid="session-thumb"
      data-ready={loaded}
    >
      <BoardThumb seed={session.id} className="absolute inset-0" />
      {src ? (
        <img
          src={src}
          alt=""
          width={320}
          height={180}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-[var(--duration-slow)]',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : null}
    </div>
  );
}

/**
 * Paper thumbnail with a deterministic hand-drawn sketch (three variants).
 * Positioning is the caller's: pass `absolute inset-0` inside a sized box.
 */
export function BoardThumb({ seed, className }: { seed: string; className?: string }) {
  const variant = [...seed].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 3;
  const ink = 'oklch(0.27 0.055 248)';
  const accent = 'oklch(0.597 0.107 218.3)';
  return (
    <div className={cn('paper overflow-hidden rounded-[var(--radius-md)]', className)}>
      <svg
        viewBox="0 0 320 180"
        className="absolute inset-0 h-full w-full"
        fill="none"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden
      >
        {variant === 0 ? (
          <>
            <path d="M26 34 C74 30 150 32 208 36" stroke={ink} />
            <path
              d="M24 62 C40 59 66 60 80 63 C82 71 82 83 80 90 C64 93 40 93 24 90 C22 82 22 70 24 62"
              stroke={ink}
            />
            <path
              d="M92 62 C108 59 134 60 148 63 C150 71 150 83 148 90 C132 93 108 93 92 90 C90 82 90 70 92 62"
              stroke={ink}
            />
            <path
              d="M160 62 C176 59 202 60 216 63 C218 71 218 83 216 90 C200 93 176 93 160 90 C158 82 158 70 160 62"
              stroke={accent}
              strokeWidth="2.8"
            />
            <path d="M186 58 C176 40 128 36 96 57 M96 57 L95 48 M96 57 L104 55" stroke={accent} />
            <path d="M26 118 L26 152 M26 152 L120 152" stroke={ink} />
            <path d="M40 148 L40 126 M62 148 L62 112 M84 148 L84 134" stroke={ink} />
            <path d="M240 138 L290 138 M280 131 L290 138 L280 145" stroke={accent} />
          </>
        ) : variant === 1 ? (
          <>
            <path d="M28 30 C70 26 128 28 172 32" stroke={ink} />
            <path d="M34 150 L292 150 M34 150 L34 54" stroke={ink} />
            <path
              d="M40 140 C78 136 108 108 138 82 C166 58 214 50 286 62"
              stroke={accent}
              strokeWidth="2.9"
            />
            <path
              d="M40 118 C86 122 126 128 178 122 C224 116 258 104 286 92"
              stroke={ink}
              strokeDasharray="7 7"
            />
            <path
              d="M214 44 C230 40 258 41 272 44 C274 52 274 62 272 68 C256 71 230 71 214 68 C212 60 212 52 214 44"
              stroke={ink}
            />
          </>
        ) : (
          <>
            <path d="M26 32 C68 28 124 30 164 34" stroke={ink} />
            <path
              d="M40 96 C40 76 62 62 90 62 C118 62 140 76 140 96 C140 116 118 130 90 130 C62 130 40 116 42 94"
              stroke={ink}
            />
            <path
              d="M188 96 C188 76 210 62 238 62 C266 62 288 76 288 96 C288 116 266 130 238 130 C210 130 188 116 190 94"
              stroke={accent}
            />
            <path d="M146 86 L182 86 M172 79 L182 86 L172 93" stroke={accent} />
            <path d="M182 108 L146 108 M156 101 L146 108 L156 115" stroke={ink} />
            <path d="M62 158 C96 154 152 155 196 158" stroke={ink} />
          </>
        )}
      </svg>
    </div>
  );
}

export function SessionCard({
  session,
  expertName,
  portraitUrl,
  onOpen,
}: {
  session: SessionRecord;
  expertName: string;
  portraitUrl: string | null;
  onOpen: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the card is a link-like region whose overlay carries its own buttons
    <div
      role="button"
      tabIndex={0}
      className="group flex cursor-pointer flex-col gap-3 rounded-[var(--radius-lg)] text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4"
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the card itself. Enter and Space on the overlay's like/save
        // buttons bubble up here, and preventing the default would cancel the
        // button's own activation and open the session instead of liking it.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="relative aspect-video">
        <SessionThumb
          session={session}
          className="absolute inset-0 transition-transform duration-[var(--duration-base)] group-hover:scale-[1.01]"
        />
        <CardActions session={session} />
        <span className="absolute right-2 bottom-2 rounded-[5px] bg-navy-900/85 px-1.5 py-0.5 text-xs text-white tabular">
          {formatDuration(session.durationMs || session.segments * 90_000)}
        </span>
      </div>
      <div className="flex gap-3">
        <Avatar name={expertName} src={portraitUrl} size={36} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-medium leading-[1.32] tracking-[-0.01em] text-fg">
            {session.title}
          </span>
          <span className="line-clamp-2 text-sm leading-[1.42] text-fg-3 text-pretty">
            {session.description || session.promise || session.topic}
          </span>
          <span className="text-sm text-fg-2">{expertName}</span>
        </div>
      </div>
    </div>
  );
}
