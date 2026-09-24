import { cn } from '@pen/design';
import { Sparkles } from 'lucide-react';

/**
 * The AI mark: a small symbol beside an expert's name that says "this is an
 * AI expert" the way YouTube's check says "verified" — recognised at a
 * glance, never spelled out (the owner on 2026-09-24: *"a symbol or
 * something that when users see that, they know it's AI expert"*).
 *
 * The words are still there for whoever cannot see the symbol: an
 * accessible name and a hover title. The AI disclosure the room speaks in
 * one quiet line is a different thing and is untouched.
 */
export function AiMark({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <span
      role="img"
      aria-label="AI expert"
      title="AI expert"
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full bg-secondary-container text-on-secondary-container',
        className,
      )}
      style={{ width: size + 4, height: size + 4 }}
      data-testid="ai-mark"
    >
      <Sparkles size={size - 4} strokeWidth={2.25} aria-hidden />
    </span>
  );
}
