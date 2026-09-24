import { COMMENT_MAX_LENGTH, type SessionComment } from '@pen/contracts';
import { Avatar, Button, cn, useToast } from '@pen/design';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client.js';
import { trackAction } from '../lib/analytics.js';
import { relativeDay, useApp } from '../lib/context.js';

/**
 * Comments under a saved session, the way YouTube has them (ADR-0044).
 *
 * Everyone who can open the session reads the thread; an account writes.
 * A visitor sees the thread and one calm row — *Sign in to comment* — that
 * opens the sign-in sheet, never a disabled box and never a wall. The
 * author and the session's host can delete; a deletion is immediate and
 * says so once.
 *
 * The composer is the page's own: a plain textarea in the text field's
 * dress, because a comment is a paragraph and the design system's field is
 * a line. Enter submits when the platform's modifier is held, the way every
 * comment box works; plain Enter wraps.
 *
 * The thread is set a step below the page's own text — smaller, and in the
 * variant colour — so it sits under the session instead of competing with
 * it; the composer keeps the body size because it is the reader's own words.
 */
export function Comments({
  sessionId,
  hostId,
  className,
}: {
  sessionId: string;
  /** The session's host, who may delete any comment; empty for everyone but the host. */
  hostId: string;
  className?: string;
}) {
  const { api, participant, features, openSignIn } = useApp();
  const toast = useToast();
  const [page, setPage] = useState<{
    comments: SessionComment[];
    total: number;
    nextBefore: number | null;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setPage(await api.listComments(sessionId));
    } catch {
      setFailed(true);
    }
  }, [api, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canWrite = participant !== null && features.comments;
  const isHost = participant !== null && hostId !== '' && participant.id === hostId;
  const body = draft.trim();
  const over = draft.length > COMMENT_MAX_LENGTH;

  const post = async () => {
    if (!body || over || posting) return;
    setPosting(true);
    try {
      const { comment } = await api.postComment(sessionId, body);
      trackAction('comment_posted', { sessionId, length: body.length });
      setDraft('');
      setPage((p) =>
        p
          ? { ...p, comments: [comment, ...p.comments], total: p.total + 1 }
          : { comments: [comment], total: 1, nextBefore: null },
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ACCOUNT_REQUIRED') openSignIn('comments');
      else toast(error instanceof Error ? error.message : 'Could not post that.', 'danger');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (comment: SessionComment) => {
    try {
      await api.deleteComment(sessionId, comment.id);
      trackAction('comment_deleted', {
        sessionId,
        own: participant?.id === comment.authorId,
      });
      setPage((p) =>
        p
          ? {
              ...p,
              comments: p.comments.filter((c) => c.id !== comment.id),
              total: Math.max(0, p.total - 1),
            }
          : p,
      );
      toast('Comment deleted', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not delete that.', 'danger');
    }
  };

  const more = async () => {
    if (!page?.nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.listComments(sessionId, page.nextBefore);
      setPage((p) =>
        p
          ? {
              comments: [...p.comments, ...next.comments],
              total: next.total,
              nextBefore: next.nextBefore,
            }
          : next,
      );
    } catch {
      toast('Could not load more comments.', 'danger');
    } finally {
      setLoadingMore(false);
    }
  };

  const total = page?.total ?? 0;

  return (
    <section className={cn('flex flex-col gap-5', className)} data-testid="comments">
      <h6 className="text-on-surface" data-testid="comments-count">
        {page === null && !failed
          ? 'Comments'
          : total === 0
            ? 'No comments yet'
            : `${total} ${total === 1 ? 'comment' : 'comments'}`}
      </h6>

      {canWrite ? (
        <form
          className="flex items-start gap-3"
          data-testid="comment-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void post();
          }}
        >
          <Avatar
            name={participant.name}
            src={participant.avatarUrl}
            size={36}
            className="mt-0.5 shrink-0"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void post();
                }
              }}
              placeholder="Add a comment…"
              rows={draft ? 3 : 1}
              maxLength={COMMENT_MAX_LENGTH + 200}
              aria-label="Add a comment"
              dir="auto"
              className={cn(
                'w-full resize-none rounded-xs bg-transparent px-4 py-2 text-body-large text-on-surface caret-primary outline-none placeholder:text-on-surface-dim',
                'shadow-[0_0_0_1px_var(--color-outline-variant)] focus:shadow-[0_0_0_2px_var(--color-outline)]',
                over && 'shadow-[0_0_0_2px_var(--color-error)]',
              )}
              data-testid="comment-input"
            />
            {draft ? (
              <div className="flex items-center justify-end gap-2">
                {over ? (
                  <span className="mr-auto text-body-small text-error" role="alert">
                    A comment can be {COMMENT_MAX_LENGTH.toLocaleString()} characters; this one is{' '}
                    {draft.length.toLocaleString()}.
                  </span>
                ) : draft.length > COMMENT_MAX_LENGTH - 100 ? (
                  <span className="mr-auto text-body-small text-on-surface-variant tabular">
                    {COMMENT_MAX_LENGTH - draft.length} left
                  </span>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setDraft('')} disabled={posting}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={posting}
                  disabled={!body || over}
                  data-testid="comment-submit"
                >
                  Comment
                </Button>
              </div>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-3" data-testid="comment-signin">
          <Avatar name="?" size={36} className="shrink-0" />
          <button
            type="button"
            className="state-layer flex h-10 min-w-0 flex-1 items-center rounded-full px-4 text-left text-body-medium text-on-surface-variant hairline"
            onClick={() => openSignIn('comments')}
          >
            Sign in to comment
          </button>
        </div>
      )}

      {failed ? (
        <p className="text-body-medium text-error" role="alert">
          Could not load the comments.{' '}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => void load()}
          >
            Try again
          </button>
        </p>
      ) : null}

      {page && page.comments.length > 0 ? (
        <ol className="flex flex-col gap-4" data-testid="comment-list">
          {page.comments.map((c) => {
            const mine = participant?.id === c.authorId;
            return (
              <li key={c.id} className="flex items-start gap-3" data-testid={`comment-${c.id}`}>
                <Avatar
                  name={c.authorName}
                  src={c.authorAvatarUrl}
                  size={32}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-label-medium text-on-surface-variant">
                      {c.authorName}
                    </span>
                    <span className="text-label-small text-on-surface-dim">
                      {relativeDay(c.createdAt)}
                    </span>
                  </div>
                  <p
                    className="mt-0.5 whitespace-pre-wrap text-body-small text-on-surface-variant break-words"
                    dir="auto"
                  >
                    {c.body}
                  </p>
                  {mine || isHost ? (
                    <button
                      type="button"
                      className="mt-1 text-label-small text-on-surface-dim underline decoration-outline underline-offset-4 hover:text-on-surface"
                      onClick={() => void remove(c)}
                      data-testid="comment-delete"
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {page?.nextBefore ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          loading={loadingMore}
          onClick={() => void more()}
        >
          Show more
        </Button>
      ) : null}
    </section>
  );
}
