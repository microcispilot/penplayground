import { cn } from '../cn.js';

export interface CaptionProps {
  text: string;
  /** Show a blinking caret (live transcript). */
  live?: boolean;
  hint?: string;
  className?: string;
  /** BCP-47 language of the line; drives hyphenation and the screen reader's voice. */
  lang?: string;
  /** Reading direction of the line. */
  dir?: 'ltr' | 'rtl';
}

/**
 * Subtitle-style caption drawn over the board (YouTube feel, cloned box-decoration).
 *
 * A subtitle is the words. It used to put the speaker's name in front of them,
 * and it does not any more: a real expert does not write their own name and
 * transcript on the board, and nobody watching a film needs to be told which
 * of the two people on screen is talking. Who is speaking is visible — the
 * roster rings them, the orb moves — so the line carries only what was said.
 */
export function Caption({ text, live = false, hint, className, lang, dir }: CaptionProps) {
  return (
    <div
      className={cn('pointer-events-none text-center', className)}
      aria-live="polite"
      lang={lang}
      dir={dir}
    >
      <span
        className="inline rounded-xs px-[0.4em] py-[0.18em] text-body-medium text-white [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
        style={{ background: 'var(--color-caption-scrim)', textWrap: 'pretty' }}
      >
        {text}
        {live ? <span className="animate-caret">|</span> : null}
      </span>
      {hint ? (
        <div className="mt-1.5">
          {/* Its own scrim: the hint lands on paper, where white text would vanish. */}
          <span
            className="inline rounded-xs px-[0.4em] py-[0.15em] text-label-small text-white/85"
            style={{ background: 'var(--color-caption-scrim)' }}
          >
            {hint}
          </span>
        </div>
      ) : null}
    </div>
  );
}
