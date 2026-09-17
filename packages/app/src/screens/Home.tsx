import type { Expert } from '@pen/contracts';
import { Button, Chip, Skeleton, useToast } from '@pen/design';
import { ArrowRight, Mic, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, type SessionRecord } from '../api/client.js';
import { AppHeader } from '../components/AppHeader.js';
import { SessionCard } from '../components/SessionCard.js';
import { useApp } from '../lib/context.js';

const DOMAIN_LABELS: Record<string, string> = {
  'computing-data': 'Computing',
  'math-science-engineering': 'Science',
  'business-finance-career': 'Finance',
  'health-law-civics': 'Health & Law',
  'humanities-languages': 'Humanities',
  'arts-design': 'Design',
  'life-skills': 'Life skills',
  'learning-and-careers': 'Learning',
};

const QUICK = [
  'How Transformers work in LLMs',
  'Swift fundamentals',
  'Reading an ECG strip',
  'How TCP handshakes work',
];

export function Home() {
  const { api, participant, platform } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [experts, setExperts] = useState<Map<string, Expert>>(new Map());
  const [category, setCategory] = useState('All');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listPublicSessions(), api.listExperts()])
      .then(([s, e]) => {
        if (cancelled) return;
        setSessions(s);
        setExperts(new Map(e.map((x) => [x.id, x])));
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const categories = useMemo(
    () => ['All', ...new Set((sessions ?? []).map((s) => DOMAIN_LABELS[s.domain] ?? 'Other'))],
    [sessions],
  );
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (sessions ?? []).filter(
      (s) =>
        (category === 'All' || (DOMAIN_LABELS[s.domain] ?? 'Other') === category) &&
        (!f ||
          `${s.title} ${s.topic} ${experts.get(s.expertId)?.displayName ?? ''}`
            .toLowerCase()
            .includes(f)),
    );
  }, [sessions, category, filter, experts]);

  /** Voice search: the platform recognizer fills the box; Enter/Start still confirms. */
  const listen = () => {
    if (listening) return;
    const recognizer = platform.speech.create(
      {
        onPartial: (_id, text) => setQuery(text),
        onFinal: (_id, text) => {
          setQuery(text);
          setListening(false);
          recognizer.stop();
        },
        onError: (code) => {
          setListening(false);
          toast(
            code === 'not-allowed'
              ? 'Microphone access was denied.'
              : 'Speech recognition is not available here.',
            'danger',
          );
        },
      },
      { language: navigator.language || 'en-US' },
    );
    if (!recognizer.available) {
      toast('Speech recognition is not available in this browser.', 'danger');
      return;
    }
    setListening(true);
    void recognizer.start();
    window.setTimeout(() => {
      if (listening) recognizer.stop();
    }, 12_000);
  };

  const start = async (topic: string) => {
    const t = topic.trim();
    if (!t || starting) return;
    if (!participant) {
      toast('Connecting to Pen Academy…');
      return;
    }
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
      <section className="px-7 pt-[76px] pb-[60px]">
        <div className="mx-auto flex w-full max-w-[756px] flex-col items-center">
          <h1 className="mb-8 text-center text-3xl leading-[1.02] tracking-[-0.036em] text-fg text-pretty">
            What do you want to learn?
          </h1>
          <form
            className="flex h-[60px] w-full items-center gap-2 rounded-[var(--radius-lg)] bg-surface pr-2 pl-[18px] hairline focus-within:shadow-[0_0_0_2px_var(--color-accent)]"
            onSubmit={(e) => {
              e.preventDefault();
              void start(query);
            }}
          >
            <Search size={18} className="shrink-0 text-fg-3" aria-hidden />
            <input
              className="h-full min-w-0 flex-1 bg-transparent text-[17px] text-fg outline-none placeholder:text-fg-3 caret-accent"
              placeholder="Ask for anything — “how Transformers work in LLMs”"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="What do you want to learn?"
              // biome-ignore lint/a11y/noAutofocus: the page has one purpose and one field; focus belongs there (mockup)
              autoFocus
            />
            <button
              type="button"
              title="Say it instead"
              aria-label="Say it instead"
              aria-pressed={listening}
              className={`grid size-11 shrink-0 place-items-center rounded-[11px] transition-colors ${listening ? 'bg-presence-soft text-presence' : 'text-fg-3 hover:bg-surface-2 hover:text-fg'}`}
              onClick={listen}
            >
              <Mic size={19} />
            </button>
            <span className="h-7 w-px shrink-0 bg-line-strong" aria-hidden />
            <Button
              variant="primary"
              size="lg"
              type="submit"
              disabled={!query.trim()}
              loading={starting}
              trailing={<ArrowRight size={16} />}
            >
              Start session
            </Button>
          </form>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {QUICK.map((q) => (
              <Chip key={q} onClick={() => setQuery(q)}>
                {q}
              </Chip>
            ))}
          </div>
        </div>
      </section>

      <div className="sticky top-[65px] z-[9] bg-bg px-7 pt-[22px] pb-2.5">
        <div className="mx-auto flex max-w-[1360px] items-center gap-3">
          <h2 className="shrink-0 text-[19px] tracking-[-0.02em]">Most learned</h2>
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-auto py-1">
            {categories.map((c) => (
              <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
                {c}
              </Chip>
            ))}
          </div>
          <label className="flex h-7 w-[280px] shrink-0 items-center gap-2 rounded-[var(--radius-sm)] bg-surface px-2.5 hairline">
            <Search size={13} className="shrink-0 text-fg-3" aria-hidden />
            <input
              className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-3"
              placeholder="Filter sessions"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter sessions"
            />
          </label>
        </div>
      </div>

      <main className="flex-1 px-7 pt-3 pb-20">
        <div className="mx-auto grid max-w-[1360px] grid-cols-[repeat(auto-fill,minmax(288px,1fr))] gap-x-[18px] gap-y-[34px]">
          {sessions === null
            ? Array.from({ length: 8 }, (_, i) => `sk-${i}`).map((k) => (
                <div key={k} className="flex flex-col gap-3">
                  <Skeleton className="aspect-video" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))
            : visible.map((s) => {
                const expert = experts.get(s.expertId);
                return (
                  <SessionCard
                    key={s.id}
                    session={s}
                    expertName={expert?.displayName ?? 'AI expert'}
                    portraitUrl={api.portraitUrl(expert?.portrait?.src)}
                    onOpen={() => navigate(`/sessions/${s.id}`)}
                  />
                );
              })}
          {sessions !== null && visible.length === 0 ? (
            <div className="col-span-full flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-md text-fg">Nothing here yet.</p>
              <p className="text-sm text-fg-2">
                Start a session above — it becomes the first one in this list.
              </p>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
