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
        className="inline rounded-[2px] px-[0.4em] py-[0.18em] text-[13.5px] leading-[1.5] text-white [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
        style={{ background: 'oklch(0.12 0 0 / 66%)', textWrap: 'pretty' }}
      >
        <span
          style={{ color: who === 'expert' ? 'oklch(0.85 0.06 214)' : 'var(--color-presence)' }}
        >
          {speaker}:
        </span>{' '}
        {text}
        {live ? <span className="animate-caret">|</span> : null}
      </span>
      {hint ? <div className="mt-1.5 text-[11px] text-white/70 drop-shadow">{hint}</div> : null}
    </div>
  );
}
