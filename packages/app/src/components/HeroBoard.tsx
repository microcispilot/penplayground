import type { Expert } from '@pen/contracts';
import { cn, ExpertOrb } from '@pen/design';
import { useEffect, useState } from 'react';

/**
 * The product, shown rather than described: a paper board that is written on
 * at a human pace while the expert speaks, then wiped and written again.
 * Every line is real content from the prepared Transformers lesson.
 */
interface Beat {
  /** What the expert says while the line is written. */
  say: string;
  /** What lands on the board. */
  write: string;
  kind: 'title' | 'line' | 'accent' | 'note';
}

const BEATS: Beat[] = [
  {
    say: 'Let’s start with a sentence, because that’s all a language model ever sees.',
    write: 'How Transformers work',
    kind: 'title',
  },
  {
    say: 'Six tokens. That is everything the model sees at first.',
    write: 'the · cat · sat · on · the · mat',
    kind: 'line',
  },
  {
    say: 'Each token becomes a vector: a list of numbers the model can do maths on.',
    write: 'token → vector  [0.2, −1.1, 0.7 …]',
    kind: 'line',
  },
  {
    say: 'Attention lets “sat” look at “cat” and decide how much it matters.',
    write: 'attention:  sat  ⟶  cat   (how much?)',
    kind: 'accent',
  },
  {
    say: 'Good question. Without it the dot products get huge as the vectors get longer.',
    write: 'You asked: why ÷ √d ?  keeps the scores from blowing up',
    kind: 'note',
  },
];

const STEP_MS = 3000;
const PAUSE_STEPS = 1;

export function HeroBoard({
  expert,
  portraitUrl,
  className,
}: {
  expert: Expert | null;
  portraitUrl: string | null;
  className?: string;
}) {
  // Open on the third beat so the first paint already shows a board being used.
  const [step, setStep] = useState(2);
  useEffect(() => {
    const total = BEATS.length + PAUSE_STEPS;
    const id = window.setInterval(() => setStep((s) => (s + 1) % total), STEP_MS);
    return () => window.clearInterval(id);
  }, []);
  const visible = Math.min(step + 1, BEATS.length);
  const current = BEATS[Math.min(step, BEATS.length - 1)] ?? BEATS[0];
  const resting = step >= BEATS.length;
  const name = expert?.displayName.split(' ')[0] ?? 'Ada';

  return (
    <div className={cn('relative min-w-0', className)} aria-hidden>
      {/* the board */}
      <div
        className="paper relative aspect-[16/11] w-full overflow-hidden rounded-[var(--radius-xl)] shadow-board"
        style={{ transform: 'rotate(-1.2deg)' }}
      >
        <div className="absolute inset-x-0 top-0 flex h-9 items-center gap-2 px-4 text-[12px] text-ink-muted">
          <span className="size-2 rounded-full bg-presence" />
          You’re viewing {name}’s board
        </div>
        <div className="absolute inset-x-8 top-14 flex flex-col gap-[18px]">
          {BEATS.map((b, i) => (
            <BoardLine
              key={b.write}
              beat={b}
              state={
                i < visible - 1
                  ? 'done'
                  : i === visible - 1 && !resting
                    ? 'writing'
                    : i === visible - 1
                      ? 'done'
                      : 'hidden'
              }
            />
          ))}
        </div>
        {/* the expert */}
        <div className="absolute right-5 bottom-5 flex items-end gap-3">
          <div
            className="max-w-[240px] rounded-[14px] rounded-br-[4px] bg-navy-900/90 px-3.5 py-2.5 text-[13px] leading-[1.4] text-white shadow-card backdrop-blur"
            key={current?.say}
          >
            <span className="animate-rise block" style={{ animationDuration: '400ms' }}>
              {resting
                ? 'Quick one back at you: when “sat” attends to “cat”, what is being compared?'
                : current?.say}
            </span>
          </div>
          <ExpertOrb
            name={expert?.displayName ?? 'Expert'}
            portraitUrl={portraitUrl}
            presence={resting ? 'listening' : 'speaking'}
            size={64}
          />
        </div>
      </div>
      {/* the learner’s caption under the board */}
      <div className="absolute -bottom-6 left-6 flex items-center gap-2 rounded-full bg-bg-elevated px-3 py-1.5 text-[13px] text-fg-2 shadow-float">
        <span className={cn('size-2 rounded-full', resting ? 'bg-presence' : 'bg-fg-3/60')} />
        {resting ? 'Listening to you…' : 'Say anything to interrupt'}
      </div>
    </div>
  );
}

function BoardLine({ beat, state }: { beat: Beat; state: 'hidden' | 'writing' | 'done' }) {
  const base =
    'font-hand whitespace-nowrap leading-none transition-[clip-path,opacity] ease-linear';
  const style =
    beat.kind === 'title'
      ? 'text-[34px] text-ink-accent'
      : beat.kind === 'accent'
        ? 'text-[26px] text-ink-accent'
        : beat.kind === 'note'
          ? 'inline-block rounded-md bg-ink-highlight px-2 py-1 text-[22px] text-ink'
          : 'text-[26px] text-ink';
  return (
    <div
      className={cn(base, style, state === 'hidden' && 'opacity-0')}
      style={{
        clipPath: state === 'hidden' ? 'inset(0 100% 0 0)' : 'inset(0 0 0 0)',
        transitionDuration:
          state === 'writing' ? `${Math.max(1200, beat.write.length * 85)}ms` : '0ms',
      }}
    >
      {beat.write}
      {beat.kind === 'title' ? (
        <svg
          viewBox="0 0 300 8"
          className="mt-1 block h-2 w-[60%]"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d="M2 5 C60 1 140 7 298 3"
            stroke="var(--color-aqua-400)"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
    </div>
  );
}
