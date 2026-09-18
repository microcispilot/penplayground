import { cn, useToast } from '@pen/design';
import { Bookmark, Heart } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { SessionRecord } from '../api/client.js';
import { useApp } from '../lib/context.js';
import { likesShown, useLists } from '../lib/lists.js';

type Size = 'sm' | 'md';

const BOX: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-[12.5px]',
  md: 'h-9 gap-2 px-3 text-[13px]',
};
const ICON: Record<Size, number> = { sm: 15, md: 16 };

/**
 * Which surface the control is sitting on. `page` follows the theme like every
 * other control; `paper` does not, because the board — and a card's thumbnail,
 * which is a picture of one — is always the same light sheet in both themes.
 */
export type ControlSurface = 'page' | 'paper';

/** Idle / liked / saved skins, per surface. The paper ones are fixed tokens (tokens.css). */
const IDLE: Record<ControlSurface, string> = {
  page: 'bg-fg/[0.06] text-fg-2 hover:bg-fg/[0.1] hover:text-fg',
  paper: 'bg-on-paper-chip text-on-paper hover:bg-white',
};
const LIKED: Record<ControlSurface, string> = {
  page: 'bg-danger-soft text-danger',
  paper: 'bg-on-paper-chip text-on-paper-liked',
};
const SAVED: Record<ControlSurface, string> = {
  page: 'bg-accent-soft text-accent-strong',
  paper: 'bg-on-paper-chip text-on-paper-saved',
};

/**
 * Like and save (ADR-0015): both are optimistic — the icon fills and the count
 * moves the moment it is pressed, and goes back with a short message if the
 * server refuses. They work for an anonymous participant too; signing in
 * brings the list along, so nothing here needs to nag about an account.
 */
export function LikeButton({
  session,
  size = 'md',
  surface = 'page',
  className,
}: {
  session: Pick<SessionRecord, 'id' | 'likes'>;
  size?: Size;
  surface?: ControlSurface;
  className?: string;
}) {
  const { api } = useApp();
  const toast = useToast();
  const liked = useLists((s) => s.likedIds.has(session.id));
  const likesOf = useLists((s) => s.likesOf);
  const toggle = useLists((s) => s.toggleLiked);
  const count = likesShown(likesOf, { id: session.id, likes: session.likes });

  return (
    <button
      type="button"
      data-testid="like-button"
      aria-pressed={liked}
      aria-label={liked ? `Liked · ${count}` : `Like · ${count}`}
      title={liked ? 'Remove from Liked' : 'Like'}
      className={cn(
        'inline-flex items-center rounded-full font-medium transition-colors duration-[var(--duration-fast)]',
        BOX[size],
        liked ? LIKED[surface] : IDLE[surface],
        className,
      )}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        toggle(api, session.id, session.likes).catch(() =>
          toast('Could not save that just now.', 'danger'),
        );
      }}
    >
      <Heart size={ICON[size]} fill={liked ? 'currentColor' : 'none'} />
      {count > 0 ? <span className="tabular">{count}</span> : null}
    </button>
  );
}

export function SaveButton({
  session,
  size = 'md',
  surface = 'page',
  withLabel = false,
  className,
}: {
  session: Pick<SessionRecord, 'id'>;
  size?: Size;
  surface?: ControlSurface;
  /** "Learn later" beside the icon (the session page); the card stays iconic. */
  withLabel?: boolean;
  className?: string;
}) {
  const { api } = useApp();
  const toast = useToast();
  const saved = useLists((s) => s.savedIds.has(session.id));
  const toggle = useLists((s) => s.toggleSaved);

  return (
    <button
      type="button"
      data-testid="save-button"
      aria-pressed={saved}
      aria-label={saved ? 'Saved to Learn later' : 'Save to Learn later'}
      title={saved ? 'Remove from Learn later' : 'Save to Learn later'}
      className={cn(
        'inline-flex items-center rounded-full font-medium transition-colors duration-[var(--duration-fast)]',
        BOX[size],
        saved ? SAVED[surface] : IDLE[surface],
        className,
      )}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        toggle(api, session.id).catch(() => toast('Could not save that just now.', 'danger'));
      }}
    >
      <Bookmark size={ICON[size]} fill={saved ? 'currentColor' : 'none'} />
      {withLabel ? <span>{saved ? 'Saved' : 'Learn later'}</span> : null}
    </button>
  );
}

/**
 * The pair as a card overlay: quiet until the card is hovered or something in
 * it has focus, and always visible once the learner has liked or saved it.
 *
 * It floats on the thumbnail, which is a picture of the board and therefore
 * the same light paper in both themes — so these two wear the paper skin, not
 * the page one (`ControlSurface`).
 */
export function CardActions({
  session,
  className,
}: {
  session: Pick<SessionRecord, 'id' | 'likes'>;
  /** The card stacks these above its own stretched "open" control; see SessionCard. */
  className?: string;
}) {
  const marked = useLists((s) => s.likedIds.has(session.id) || s.savedIds.has(session.id));
  return (
    <div
      data-testid="card-actions"
      className={cn(
        'absolute top-2 left-2 flex gap-1.5 transition-opacity duration-[var(--duration-base)]',
        marked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        className,
      )}
    >
      <LikeButton session={session} size="sm" surface="paper" className="shadow-card" />
      <SaveButton session={session} size="sm" surface="paper" className="shadow-card" />
    </div>
  );
}
