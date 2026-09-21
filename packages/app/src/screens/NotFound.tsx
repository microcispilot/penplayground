import { Button, cn, useToast } from '@pen/design';
import { ArrowRight, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../api/client.js';
import { PenMark } from '../components/AppHeader.js';
import { markStartClicked } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useSeo } from '../lib/seo.js';

/**
 * A dead end is still an invitation: the mark, one plain sentence about what
 * happened, and the same thing the home page offers — a box you type a topic
 * into. Nothing here alarms; a stale link is not an error.
 *
 * It renders inside the shell (ADR-0015), so the header and the sidebar are
 * already on the page: this screen is only the panel between them, and fills
 * the height it is given rather than claiming the viewport.
 */
export function NotFound() {
  const navigate = useNavigate();
  const toast = useToast();
  const { api, participant } = useApp();
  const [topic, setTopic] = useState('');
  const [starting, setStarting] = useState(false);
  useSeo({
    title: 'Page not found',
    description: 'That page is not here — start a session on any topic instead.',
    noindex: true,
  });

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const t = topic.trim();
    if (!t || starting) return;
    if (!participant) {
      toast('Connecting to Pen Playground…');
      return;
    }
    markStartClicked();
    setStarting(true);
    try {
      const { session } = await api.createSession({ topic: t });
      navigate(`/room/${session.id}`, { state: { fresh: true } });
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not start the session', 'danger');
      setStarting(false);
    }
  };

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-16">
      <div className="flex w-full max-w-[560px] flex-col items-center text-center">
        <span className="animate-rise mb-6 grid size-14 place-items-center rounded-lg-increased bg-surface-container text-on-surface shadow-level2">
          <PenMark size={28} />
        </span>
        <h1
          className="animate-rise text-headline-medium text-on-surface text-pretty"
          style={{ animationDelay: '60ms' }}
        >
          This page wandered off
        </h1>
        <p
          className="animate-rise mt-4 max-w-[420px] text-body-large text-on-surface-variant text-pretty"
          style={{ animationDelay: '120ms' }}
        >
          The link may be old, or the session was private. What you came to learn is still one
          sentence away.
        </p>

        <form
          className={cn(
            'animate-rise mt-8 flex min-h-[58px] w-full items-center gap-1 rounded-lg-increased bg-surface-container p-2 pl-4 shadow-level2 transition-shadow duration-[var(--duration-base)]',
            'focus-within:shadow-[var(--shadow-level3),0_0_0_2px_var(--color-primary)]',
          )}
          style={{ animationDelay: '180ms' }}
          onSubmit={(e) => void start(e)}
        >
          <Search size={18} className="shrink-0 text-on-surface-dim" aria-hidden />
          <input
            className="h-11 min-w-0 flex-1 bg-transparent px-3 text-body-large text-on-surface caret-primary outline-none placeholder:text-on-surface-dim"
            placeholder="why pi never ends"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-label="What do you want to learn?"
            spellCheck
            autoCorrect="on"
            autoCapitalize="sentences"
          />
          <Button
            variant="primary"
            type="submit"
            disabled={!topic.trim() || starting}
            trailing={<ArrowRight size={15} />}
          >
            {starting ? 'Starting…' : 'Start'}
          </Button>
        </form>

        <div
          className="animate-rise mt-7 flex items-center gap-2 text-body-medium"
          style={{ animationDelay: '240ms' }}
        >
          <Button variant="ghost" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
          <span className="text-on-surface-dim" aria-hidden>
            ·
          </span>
          <Button variant="ghost" onClick={() => navigate('/sessions')}>
            My sessions
          </Button>
        </div>
      </div>
    </div>
  );
}
