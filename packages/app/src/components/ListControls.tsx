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
 * Like and save (ADR-0015): both are optimistic — the icon fills and the count
 * moves the moment it is pressed, and goes back with a short message if the
 * server refuses. They work for an anonymous participant too; signing in
 * brings the list along, so nothing here needs to nag about an account.
 */
export function LikeButton({
  session,
  size = 'md',
  className,
}: {
  session: Pick<SessionRecord, 'id' | 'likes'>;
  size?: Size;
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
        liked
          ? 'bg-danger-soft text-danger'
          : 'bg-fg/[0.06] text-fg-2 hover:bg-fg/[0.1] hover:text-fg',
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
  withLabel = false,
  className,
}: {
  session: Pick<SessionRecord, 'id'>;
  size?: Size;
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
        saved
          ? 'bg-accent-soft text-accent-strong'
          : 'bg-fg/[0.06] text-fg-2 hover:bg-fg/[0.1] hover:text-fg',
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
 */
export function CardActions({ session }: { session: Pick<SessionRecord, 'id' | 'likes'> }) {
  const marked = useLists((s) => s.likedIds.has(session.id) || s.savedIds.has(session.id));
  return (
    <div
      data-testid="card-actions"
      className={cn(
        'absolute top-2 left-2 flex gap-1.5 transition-opacity duration-[var(--duration-base)]',
        marked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
      )}
    >
      <LikeButton session={session} size="sm" className="shadow-card backdrop-blur-sm" />
      <SaveButton session={session} size="sm" className="shadow-card backdrop-blur-sm" />
    </div>
  );
}
