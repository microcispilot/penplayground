import { Avatar, cn } from '@pen/design';
import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '../api/client.js';
import { formatDuration, useApp } from '../lib/context.js';
import { CardActions } from './ListControls.js';

/**
 * Poll schedule while a fresh session's picture is still being generated
 * (ADR-0013, ADR-0021): ~2 minutes in total, against a generation that takes
 * ~11 s and only starts once the learner can hear the expert.
 */
const THUMB_POLL_MS = [3_000, 5_000, 8_000, 13_000, 21_000, 34_000, 40_000];
/** Older sessions with no thumbnail are not going to get one; do not poll for them. */
const THUMB_WATCH_WINDOW_MS = 30 * 60_000;

/**
 * The session's real thumbnail (the picture generated for it) over the
 * deterministic placeholder, which stays underneath until the image has
 * loaded so the card never flashes empty. With `watch`, a session that has
 * no picture yet is polled on a slow back-off and upgrades in place — the
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
      className={cn(
        // The placeholder is paper in both themes and a photograph carries its
        // own light, so the frame needs its own edge either way: a hairline and
        // a short shadow, the way a video still sits above the page on YouTube
        // (--shadow-thumb, tokens.css).
        'overflow-hidden rounded-md shadow-[var(--shadow-thumb)]',
        className,
      )}
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
    <div className={cn('paper overflow-hidden rounded-md', className)}>
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
    /*
      The whole card opens the session, and the card also carries two controls
      of its own. A control may not contain other controls: a `role="button"`
      wrapper around the like and save buttons is axe's `nested-interactive`,
      rated serious — a screen reader does not reliably reach the inner ones
      and the focus order goes wrong.

      So the card is a plain container, and the thing you press is a real
      button stretched across it, named by the session's title; like and save
      sit on a layer above it. Three tab stops and no nesting, and because the
      button is exactly the container's box its own focus ring still draws
      around the whole card. This is the arrangement YouTube uses.
    */
    <div className="group relative flex flex-col gap-3 rounded-lg text-left">
      {/*
        z-10, not z-0: the thumbnail's own wrapper is positioned and comes
        later in the tree, so at the same level it would paint over this and
        swallow every click on the picture — the biggest target on the card.
        The ring is the button's own, and the button is exactly the card's
        box, so it draws where the comment above says it does and focusing
        the heart does not also ring the whole card.
      */}
      <button
        type="button"
        data-testid="session-card-open"
        className="absolute inset-0 z-10 cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-4"
        onClick={onOpen}
      >
        <span className="sr-only">{session.title}</span>
      </button>
      <div className="relative aspect-video">
        <SessionThumb
          session={session}
          // Hover lifts the edge, never the size: a card that grows under the pointer is a
          // motion nobody asked for (the owner, 2026-09-25).
          className="absolute inset-0 transition-shadow duration-[var(--duration-base)] group-hover:shadow-[var(--shadow-thumb-hover)]"
        />
        <CardActions session={session} className="z-20" />
        <span className="absolute right-2 bottom-2 rounded-sm bg-scrim/85 px-1.5 py-0.5 text-body-small text-white tabular">
          {formatDuration(session.durationMs || session.segments * 90_000)}
        </span>
      </div>
      {/*
        Three registers, never one paragraph — the separation YouTube gets from
        title, channel and metadata. The title is the loudest line. The teacher's
        name comes straight under it as attribution: smaller and tighter than the
        title, but heavier and darker than the description, which is the lightest,
        greyest and (deliberately) slightly larger of the three, so nothing about
        it reads as a heading.
      */}
      <div className="flex gap-3">
        <Avatar name={expertName} src={portraitUrl} size={36} />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="line-clamp-2 text-title-small font-medium text-on-surface">
            {session.title}
          </span>
          <span className="truncate text-body-small font-medium text-on-surface-variant">
            {expertName}
          </span>
          <span className="line-clamp-2 text-body-medium font-normal text-on-surface-dim text-pretty">
            {session.description || session.promise || session.topic}
          </span>
        </div>
      </div>
    </div>
  );
}
