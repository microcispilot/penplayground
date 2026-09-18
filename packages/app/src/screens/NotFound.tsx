import { Button, cn, useToast } from '@pen/design';
import { ArrowRight, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../api/client.js';
import { AppHeader, PenMark } from '../components/AppHeader.js';
import { markStartClicked } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useSeo } from '../lib/seo.js';

/**
 * A dead end is still an invitation: the mark, one plain sentence about what
 * happened, and the same thing the home page offers — a box you type a topic
 * into. Nothing here alarms; a stale link is not an error.
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
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(50% 55% at 50% 0%, var(--color-wash-aqua), transparent 70%), radial-gradient(60% 50% at 50% 110%, var(--color-wash-yellow), transparent 70%)',
          }}
        />
        <div className="flex w-full max-w-[560px] flex-col items-center text-center">
          <span className="animate-rise mb-6 grid size-14 place-items-center rounded-[18px] bg-bg-elevated text-fg shadow-float">
            <PenMark size={28} />
          </span>
          <h1
            className="animate-rise text-[clamp(1.9rem,4vw,2.6rem)] leading-[1.05] tracking-[-0.03em] text-fg text-pretty"
            style={{ animationDelay: '60ms' }}
          >
            This page wandered off
          </h1>
          <p
            className="animate-rise mt-4 max-w-[420px] text-[16px] leading-[1.55] text-fg-2 text-pretty"
            style={{ animationDelay: '120ms' }}
          >
            The link may be old, or the session was private. What you came to learn is still one
            sentence away.
          </p>

          <form
            className={cn(
              'animate-rise mt-8 flex min-h-[58px] w-full items-center gap-1 rounded-[18px] bg-bg-elevated p-2 pl-4 shadow-float transition-shadow duration-[var(--duration-base)]',
              'focus-within:shadow-[var(--shadow-lift),0_0_0_2px_var(--color-accent)]',
            )}
            style={{ animationDelay: '180ms' }}
            onSubmit={(e) => void start(e)}
          >
            <Search size={18} className="shrink-0 text-fg-3" aria-hidden />
            <input
              className="h-11 min-w-0 flex-1 bg-transparent px-3 text-[16px] text-fg caret-accent outline-none placeholder:text-fg-3"
              placeholder="Try “how Transformers work in LLMs”"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              aria-label="What do you want to learn?"
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
            className="animate-rise mt-7 flex items-center gap-2 text-sm"
            style={{ animationDelay: '240ms' }}
          >
            <Button variant="ghost" onClick={() => navigate('/')}>
              Explore sessions
            </Button>
            <span className="text-fg-3" aria-hidden>
              ·
            </span>
            <Button variant="ghost" onClick={() => navigate('/sessions')}>
              My sessions
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
