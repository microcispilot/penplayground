import { cn } from '../cn.js';

export interface CaptionProps {
  speaker: string;
  text: string;
  /** 'expert' (accent name) or 'learner' (presence-green name). */
  who: 'expert' | 'learner';
  /** Show a blinking caret (live transcript). */
  live?: boolean;
  hint?: string;
  className?: string;
}

/** Subtitle-style caption drawn over the board (YouTube feel, cloned box-decoration). */
export function Caption({ speaker, text, who, live = false, hint, className }: CaptionProps) {
  return (
    <div className={cn('pointer-events-none text-center', className)} aria-live="polite">
      <span
        className="inline rounded-[2px] px-[0.4em] py-[0.18em] text-[13px] leading-[1.55] text-white [box-decoration-break:clone] [-webkit-box-decoration-break:clone] sm:text-[13.5px]"
        style={{ background: 'var(--color-caption-scrim)', textWrap: 'pretty' }}
      >
        <span
          style={{
            color:
              who === 'expert' ? 'var(--color-caption-expert)' : 'var(--color-caption-learner)',
          }}
        >
          {speaker}:
        </span>{' '}
        {text}
        {live ? <span className="animate-caret">|</span> : null}
      </span>
      {hint ? (
        <div className="mt-1.5">
          {/* Its own scrim: the hint lands on paper, where white text would vanish. */}
          <span
            className="inline rounded-[2px] px-[0.4em] py-[0.15em] text-[11px] text-white/85"
            style={{ background: 'var(--color-caption-scrim)' }}
          >
            {hint}
          </span>
        </div>
      ) : null}
    </div>
  );
}
