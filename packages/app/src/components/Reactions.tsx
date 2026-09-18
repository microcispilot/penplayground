import { REACTION_LABEL, REACTION_TTL_MS, REACTIONS, type Reaction } from '@pen/contracts';
import { Avatar, cn, IconButton } from '@pen/design';
import { Smile } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNow } from '../lib/use-now.js';
import { type LiveReaction, visibleReactions } from '../room/reactions.js';

/**
 * Reactions: the way a room of twelve says something without taking the floor.
 *
 * Two halves, the way every call app that does this well splits them — the
 * picker lives with the controls, and what it produces appears on the people.
 * Both are deliberately small: the expert is mid-sentence, and a reaction must
 * never look like an interruption.
 */

// ── the picker ────────────────────────────────────────────────────────────────

/**
 * One smiley in the bar; one horizontal row of emoji above it. Not a grid, not
 * a panel with a heading — eight fixed glyphs, each in its own hit target, and
 * the row closes the moment one is sent.
 */
export function ReactionPicker({
  disabled,
  disabledReason,
  onReact,
}: {
  disabled: boolean;
  /** Why the control is off (an ad is up), for the label; never an alarm. */
  disabledReason?: string;
  onReact: (emoji: Reaction) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // An ad closes it along with everything else it disables.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  /** ← → walk the row and wrap; Home and End jump to its ends. */
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const buttons = [
      ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-reaction]') ?? []),
    ];
    const here = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (here === -1 || buttons.length === 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : (here + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      {open ? (
        <div
          // A row of controls is a toolbar, and a toolbar is walked with the
          // arrow keys — Tab leaves it rather than stepping through eight.
          role="toolbar"
          aria-orientation="horizontal"
          aria-label="Send a reaction"
          data-testid="reaction-row"
          onKeyDown={onRowKey}
          className="absolute end-0 bottom-[calc(100%+10px)] z-[20] flex animate-rise items-center gap-0.5 rounded-full bg-bg-elevated p-1 shadow-pop hairline"
        >
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-testid={`reaction-${emoji}`}
              data-reaction={emoji}
              aria-label={`React — ${REACTION_LABEL[emoji]}`}
              title={REACTION_LABEL[emoji]}
              onClick={() => {
                onReact(emoji);
                setOpen(false);
              }}
              className="grid size-9 place-items-center rounded-[var(--radius-sm)] text-[20px] leading-none transition-[background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:scale-110 hover:bg-surface-2 focus-visible:outline-accent motion-reduce:hover:scale-100"
            >
              <span aria-hidden>{emoji}</span>
            </button>
          ))}
        </div>
      ) : null}
      <IconButton
        label={disabled ? (disabledReason ?? 'Reactions are off right now') : 'Send a reaction'}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        className={cn(open && 'bg-surface-2 text-fg')}
        data-testid="reaction-toggle"
      >
        <Smile size={17} />
      </IconButton>
    </div>
  );
}

// ── what everyone sees ────────────────────────────────────────────────────────

/**
 * The sender's face and their emoji, in one small pill over the people, rising
 * a little and fading out. Stacked rather than overlapped, newest at the
 * bottom, and capped — a room tapping at once must not bury the participants.
 */
export function ReactionPills({ reactions }: { reactions: LiveReaction[] }) {
  // Fast enough that a pill leaves when it says it will, slow enough to be free.
  const now = useNow(300);
  const shown = visibleReactions(reactions, now);
  if (shown.length === 0) return null;
  return (
    <div
      // A lane of their own just under the faces: rising off the people, never
      // covering one. Horizontal, so a room tapping at once reads as a row.
      className="pointer-events-none absolute inset-x-2 -bottom-3 z-[6] flex flex-wrap items-center justify-center gap-1"
      data-testid="reaction-pills"
      aria-live="polite"
    >
      {shown.map((r) => (
        <span
          key={r.id}
          data-testid="reaction-pill"
          data-emoji={r.emoji}
          className="pen-reaction flex items-center gap-1.5 rounded-full bg-bg-elevated/92 py-0.5 pe-2.5 ps-0.5 shadow-card backdrop-blur-[6px] hairline"
        >
          {/* The face, proud of the pill's edge: whose reaction this is, at a glance. */}
          <Avatar name={r.name} hue={r.hue} size={20} className="-ms-1.5 ring-2 ring-bg-elevated" />
          <span
            role="img"
            aria-label={`${r.name} reacted — ${REACTION_LABEL[r.emoji]}`}
            className="text-[15px] leading-none"
          >
            {r.emoji}
          </span>
        </span>
      ))}
      <style>{`
        .pen-reaction { animation: pen-reaction-float ${REACTION_TTL_MS}ms var(--ease-out) forwards; }
        @keyframes pen-reaction-float {
          0%   { opacity: 0; transform: translateY(6px) scale(0.92); }
          12%  { opacity: 1; transform: translateY(0) scale(1); }
          70%  { opacity: 1; transform: translateY(-3px) scale(1); }
          100% { opacity: 0; transform: translateY(-8px) scale(0.98); }
        }
        @media (prefers-reduced-motion: reduce) {
          .pen-reaction { animation: pen-reaction-fade ${REACTION_TTL_MS}ms linear forwards; }
          @keyframes pen-reaction-fade {
            0% { opacity: 0; } 10%, 75% { opacity: 1; } 100% { opacity: 0; }
          }
        }
      `}</style>
    </div>
  );
}
