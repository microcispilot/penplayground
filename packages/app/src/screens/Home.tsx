import type { Expert, PlanUsage } from '@pen/contracts';
import { planIncludes } from '@pen/contracts';
import { Chip, cn, Skeleton, useToast } from '@pen/design';
import { ArrowRight, Mic, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, type SessionRecord } from '../api/client.js';
import { PenMark } from '../components/AppHeader.js';
import { ExpertCard, ShowMoreExpertsCard } from '../components/ExpertCard.js';
import { PrivacyDialog } from '../components/PrivacyDialog.js';
import { BoardThumb, SessionCard } from '../components/SessionCard.js';
import { TOPIC_DOMAINS } from '../components/Sidebar.js';
import { markStartClicked } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';

/**
 * How many faces the row carries before it hands over to the Experts page.
 * Twelve is two comfortable screens of scrolling at every width we ship; past
 * that a horizontal rail stops being a glance and becomes a chore.
 */
const EXPERT_ROW_LIMIT = 12;
/** The persona the row always shows, third from the left. */
const PINNED_EXPERT = { id: 'aristotle', index: 2 } as const;

/** Shown while the public list is still empty: real topics, each one a session away. */
const STARTERS: { topic: string; domain: string; promise: string }[] = [
  {
    topic: 'How Transformers work in LLMs',
    domain: 'Computing',
    promise: 'Learn why attention lets a model weigh every word against every other.',
  },
  {
    topic: 'Swift fundamentals',
    domain: 'Computing',
    promise: 'Learn to write your first Swift with values, optionals and functions.',
  },
  {
    topic: 'Reading an ECG strip',
    domain: 'Health & Law',
    promise: 'Learn to read rate, rhythm and intervals from a 12-lead strip.',
  },
  {
    topic: 'How TCP handshakes work',
    domain: 'Computing',
    promise: 'Learn why three packets open a connection and how it stays reliable.',
  },
  {
    topic: 'The Pythagorean theorem, proven three ways',
    domain: 'Science',
    promise: 'Learn why a² + b² = c² from squares, similar triangles and algebra.',
  },
  {
    topic: 'How compound interest really grows',
    domain: 'Finance',
    promise: 'Learn why time beats rate, with the numbers written out.',
  },
  {
    topic: 'Rumi’s poems in the original Persian',
    domain: 'Humanities',
    promise: 'Learn to read three ghazals line by line, in Persian, with the meaning beside them.',
  },
  {
    topic: 'Colour theory for interfaces',
    domain: 'Design',
    promise: 'Learn to build a palette that stays readable in light and dark.',
  },
];

export function Home() {
  const { api, participant, platform } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [withExpert, setWithExpert] = useState<Expert | null>(null);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [filter, setFilter] = useState('');
  // The sidebar's Topics links and the chips are the same control: `?topic=<domain>` is the state.
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const category = params.get('topic') ?? 'all';
  const setCategory = (next: string) => setParams(next === 'all' ? {} : { topic: next });
  /** Today's allowance, so the page can say what is left before anyone clicks Start. */
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listPublicSessions(), api.listExperts()])
      .then(([s, e]) => {
        if (cancelled) return;
        setSessions(s);
        setExperts(e);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!participant) return;
    let cancelled = false;
    api
      .usage()
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      // The allowance is a courtesy, not a gate the client enforces: if it
      // cannot be read, the page simply says nothing and the server decides.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, participant]);

  const expertById = useMemo(() => new Map(experts.map((e) => [e.id, e])), [experts]);
  const featured = useMemo(() => {
    // One per domain first, so the row reads as breadth, then fill.
    const seen = new Set<string>();
    const first: Expert[] = [];
    const rest: Expert[] = [];
    for (const e of experts) {
      if (!e.portrait) continue;
      if (seen.has(e.domain)) rest.push(e);
      else {
        seen.add(e.domain);
        first.push(e);
      }
    }
    const ordered = [...first, ...rest];
    // One face is placed rather than ranked; everything else keeps its order.
    const pinned = ordered.find((e) => e.id === PINNED_EXPERT.id);
    const row = pinned ? ordered.filter((e) => e.id !== pinned.id) : ordered;
    if (pinned) row.splice(Math.min(PINNED_EXPERT.index, row.length), 0, pinned);
    return row.slice(0, EXPERT_ROW_LIMIT);
  }, [experts]);

  const categories = useMemo(() => {
    const present = new Set((sessions ?? []).map((s) => s.domain));
    return [{ id: 'all', label: 'All' }, ...TOPIC_DOMAINS.filter((d) => present.has(d.id))];
  }, [sessions]);
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (sessions ?? []).filter(
      (s) =>
        (category === 'all' || s.domain === category) &&
        (!f ||
          `${s.title} ${s.topic} ${expertById.get(s.expertId)?.displayName ?? ''}`
            .toLowerCase()
            .includes(f)),
    );
  }, [sessions, category, filter, expertById]);

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

  const start = async (topic: string, expertId?: string) => {
    markStartClicked();
    const t = topic.trim();
    if (!t || starting) return;
    if (!participant) {
      toast('Connecting to Pen Playground…');
      return;
    }
    setStarting(true);
    try {
      const { session } = await api.createSession(expertId ? { topic: t, expertId } : { topic: t });
      navigate(`/room/${session.id}`, { state: { fresh: true } });
    } catch (error) {
      // A plan or a daily limit is a fact about an account, not a fault: it is
      // said in the ordinary voice. Only a real failure is a danger.
      const calm = error instanceof ApiError && error.status === 402;
      toast(
        error instanceof ApiError ? error.message : 'Could not start the session',
        calm ? 'neutral' : 'danger',
      );
      setStarting(false);
    }
  };

  /** True only while today's allowance or the day's capacity is used up. */
  const waiting = usage !== null && !usage.canStart;

  const chooseExpert = (e: Expert) => {
    setWithExpert(e);
    if (!query.trim()) setQuery(e.specialties[0] ?? '');
    inputRef.current?.focus();
  };

  // Arriving from the Experts screen: that expert is already in the command bar.
  const requestedExpert = (location.state as { expertId?: string } | null)?.expertId ?? null;
  useEffect(() => {
    if (!requestedExpert) return;
    const expert = expertById.get(requestedExpert);
    // A persona this plan does not include never reaches the command bar; the
    // server would refuse the session anyway, and a chip that cannot start is
    // worse than no chip (`requiredPlan` is the server's, never computed here).
    if (!expert || !planIncludes(participant?.plan ?? 'free', expert.requiredPlan)) return;
    setWithExpert(expert);
    setQuery((q) => (q.trim() ? q : (expert.specialties[0] ?? '')));
    inputRef.current?.focus();
    // The choice is made; a refresh or a back-navigation should not make it again.
    window.history.replaceState({}, '');
  }, [requestedExpert, expertById, participant]);

  return (
    <div className="flex flex-1 flex-col">
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        {/*
          One column, centred. The animated board used to hold the right half;
          with it gone a two-column grid would read as a missing element, so the
          hero becomes what it always was underneath — a question and the field
          that answers it — at a measure wide enough to carry the display type.
        */}
        <div className="mx-auto flex w-full max-w-[820px] flex-col items-center px-6 pt-16 pb-20 text-center sm:pt-20 lg:pt-24 lg:pb-24">
          {/*
            One sentence, one voice: no word set apart in another colour, style
            or weight, and nothing underlining it. The question is the whole
            hero now, so it is sized to sit on a single line at this measure
            rather than breaking across two — it wraps only where the viewport
            is genuinely too narrow to hold it.
          */}
          <h1
            className="animate-rise text-[clamp(2.1rem,5vw,3.5rem)] leading-[1.05] tracking-[-0.035em] text-fg text-balance"
            style={{ animationDelay: '40ms' }}
          >
            What do you want to learn?
          </h1>

          <form
            className={cn(
              'animate-rise mt-10 flex min-h-[64px] w-full max-w-[720px] items-center gap-1 rounded-[20px] bg-bg-elevated p-2 pl-5 text-left shadow-ask transition-shadow duration-[var(--duration-base)]',
              'focus-within:shadow-[var(--shadow-lift),0_0_0_2px_var(--color-accent)]',
            )}
            style={{ animationDelay: '160ms' }}
            onSubmit={(e) => {
              e.preventDefault();
              void start(query, withExpert?.id);
            }}
          >
            <Search size={19} className="shrink-0 text-fg-3" aria-hidden />
            {withExpert ? (
              <span className="ml-2 flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent-soft py-0.5 pr-1.5 pl-1 text-[13px] font-medium text-accent-strong">
                <img
                  src={api.portraitUrl(withExpert.portrait?.src, 192) ?? undefined}
                  alt=""
                  width={24}
                  height={24}
                  decoding="async"
                  className="size-6 rounded-full object-cover"
                />
                with {withExpert.displayName.split(' ')[0]}
                <button
                  type="button"
                  aria-label="Any expert"
                  className="grid size-5 place-items-center rounded-full hover:bg-accent/20"
                  onClick={() => setWithExpert(null)}
                >
                  <X size={12} />
                </button>
              </span>
            ) : null}
            <input
              ref={inputRef}
              className="h-12 min-w-0 flex-1 bg-transparent px-3 text-[17px] text-fg outline-none placeholder:text-fg-3 caret-accent"
              placeholder="Try “how Transformers work in LLMs”"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="What do you want to learn?"
              // biome-ignore lint/a11y/noAutofocus: the page has one purpose and one field; focus belongs there
              autoFocus
            />
            <button
              type="button"
              title="Say it instead"
              aria-label="Say it instead"
              aria-pressed={listening}
              className={cn(
                'grid size-11 shrink-0 place-items-center rounded-full transition-colors',
                listening
                  ? 'bg-presence-soft text-presence shadow-[0_0_0_1px_var(--color-presence)]'
                  : 'text-fg-3 hover:bg-surface-2 hover:text-fg',
              )}
              onClick={listen}
            >
              <Mic size={19} />
            </button>
            <button
              type="submit"
              disabled={!query.trim() || starting || waiting}
              className="group ml-1 flex h-12 shrink-0 items-center gap-2 rounded-[14px] bg-fg px-5 text-[15px] font-medium text-bg transition-[transform,opacity,background-color] duration-[var(--duration-fast)] hover:bg-navy-700 active:scale-[0.985] disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-3 dark:hover:bg-white"
            >
              {starting ? 'Starting…' : 'Start'}
              <ArrowRight
                size={16}
                className="transition-transform duration-[var(--duration-base)] group-hover:translate-x-0.5"
              />
            </button>
          </form>

          {/* The allowance only speaks when it is in the way; the running count is gone. */}
          {waiting ? (
            <p
              className="animate-rise mt-5 max-w-[560px] text-[14px] text-fg-2 text-pretty"
              style={{ animationDelay: '220ms' }}
              data-testid="home-allowance"
            >
              {usage?.reason === 'capacity'
                ? 'Free sessions are all booked for today — they open again at midnight UTC. '
                : `That is your ${usage?.sessionsPerDay ?? 3} sessions for today. They are back at midnight UTC. `}
              <Link
                to="/pricing"
                className="text-accent-strong underline decoration-line-strong underline-offset-4 hover:decoration-accent"
              >
                Standard makes them unlimited
              </Link>
              .
            </p>
          ) : null}
        </div>
      </section>

      {/* ── experts ──────────────────────────────────────────────────────── */}
      <section className="border-t border-line/70 py-16">
        <div className="mx-auto w-full max-w-[1280px] px-6">
          <SectionBand>
            <div className="min-w-0">
              <h2 className="text-[clamp(1.6rem,2.4vw,2.1rem)] tracking-[-0.03em]">
                Taught by experts who never lose patience.
              </h2>
              <p className="mt-2 max-w-[920px] text-[15px] text-fg-2 text-pretty">
                100+ experts across science, software, coding, medicine, law, money, arts, and more.
                They can teach you in your language.
              </p>
            </div>
          </SectionBand>
          <div
            className="-mx-6 flex gap-4 overflow-x-auto px-6 pt-2 pb-5 [mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-56px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="experts-row"
          >
            {experts.length === 0
              ? Array.from({ length: 8 }, (_, i) => `sk-${i}`).map((k) => (
                  <Skeleton
                    key={k}
                    className="aspect-[4/5] w-[196px] shrink-0 rounded-[var(--radius-xl)]"
                  />
                ))
              : [
                  ...featured.map((e) => (
                    <ExpertCard
                      key={e.id}
                      expert={e}
                      portraitUrl={api.portraitUrl(e.portrait?.src, 192)}
                      selected={withExpert?.id === e.id}
                      onChoose={() => chooseExpert(e)}
                      className="w-[196px] shrink-0"
                    />
                  )),
                  <ShowMoreExpertsCard
                    key="show-more"
                    total={experts.length}
                    className="w-[196px] shrink-0"
                  />,
                ]}
          </div>
        </div>
      </section>

      {/* ── sessions ─────────────────────────────────────────────────────── */}
      <section className="border-t border-line/70 bg-surface py-16">
        <div className="mx-auto w-full max-w-[1280px] px-6">
          <SectionBand>
            <h2 className="mr-2 text-[clamp(1.6rem,2.4vw,2.1rem)] tracking-[-0.03em]">
              {sessions !== null && sessions.length === 0
                ? 'Start with one of these'
                : 'Most learned'}
            </h2>
            {sessions !== null && sessions.length > 0 ? (
              <>
                <div className="flex min-w-0 flex-1 gap-1.5 overflow-auto py-1">
                  {categories.map((c) => (
                    <Chip key={c.id} selected={category === c.id} onClick={() => setCategory(c.id)}>
                      {c.label}
                    </Chip>
                  ))}
                </div>
                <label className="flex h-9 w-full shrink-0 items-center gap-2 rounded-full bg-bg-elevated px-3.5 hairline sm:w-[260px]">
                  <Search size={14} className="shrink-0 text-fg-3" aria-hidden />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
                    placeholder="Filter sessions"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter sessions"
                  />
                </label>
              </>
            ) : sessions !== null ? (
              <p className="basis-full text-[15px] text-fg-2">
                Sessions people learn from most will gather here. Until then, these are prepared and
                ready to teach.
              </p>
            ) : null}
          </SectionBand>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-x-5 gap-y-9">
            {sessions === null
              ? Array.from({ length: 8 }, (_, i) => `sk-${i}`).map((k) => (
                  <div key={k} className="flex flex-col gap-3">
                    <Skeleton className="aspect-video rounded-[var(--radius-lg)]" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))
              : sessions.length === 0
                ? STARTERS.map((s) => (
                    <StarterCard key={s.topic} {...s} onStart={() => start(s.topic)} />
                  ))
                : visible.map((s) => {
                    const expert = expertById.get(s.expertId);
                    return (
                      <SessionCard
                        key={s.id}
                        session={s}
                        expertName={expert?.displayName ?? 'AI expert'}
                        portraitUrl={api.portraitUrl(expert?.portrait?.src, 192)}
                        onOpen={() => navigate(`/sessions/${s.id}`)}
                      />
                    );
                  })}
            {sessions !== null && sessions.length > 0 && visible.length === 0 ? (
              <div className="col-span-full flex flex-col items-center gap-1 py-16 text-center">
                <p className="text-md text-fg">No sessions match.</p>
                <p className="text-sm text-fg-2">Try another category, or clear the filter.</p>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* The bottom pane is furniture too: the same surface the sidebar sits on. */}
      <footer className="border-t border-line/70 bg-chrome">
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-8 text-[13px] text-fg-3">
          <span className="flex items-center gap-1.5 text-fg-2">
            <PenMark size={16} /> Pen Playground
          </span>
          <NavLink to="/pricing" className="hover:text-fg">
            Pricing
          </NavLink>
          <NavLink to="/sessions" className="hover:text-fg">
            Your sessions
          </NavLink>
          {/*
            Terms, Privacy and the copyright also sit in the sidebar's own
            footer, which is in the layout from 1024 px up (AppShell). One copy
            is enough: below that the sidebar is a drawer, so Home carries them.
          */}
          <NavLink to="/terms" className="hover:text-fg lg:hidden">
            Terms
          </NavLink>
          <NavLink to="/privacy" className="hover:text-fg lg:hidden">
            Privacy
          </NavLink>
          <button type="button" className="hover:text-fg" onClick={() => setPrivacyOpen(true)}>
            Privacy choices
          </button>
          <span className="flex-1" />
          {/* The AI disclosure is stated in full on Terms, which is one link away. */}
          <span className="lg:hidden">© 2026 Microcis</span>
        </div>
      </footer>
      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </div>
  );
}

/**
 * The row a section opens with — its heading, and whatever it is filtered by.
 * It sits on its own band so the controls read as the section's chrome rather
 * than as the first item of content, which is what made these rows blur into
 * the grid underneath them.
 */
/**
 * A row's heading and its line, with nothing drawn behind them. A filled panel
 * here boxed the type in and fought the cards underneath; the separation a
 * section needs is space, which is what it gets.
 */
function SectionBand({ children }: { children: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-center gap-3" data-testid="section-band">
      {children}
    </div>
  );
}

function StarterCard({
  topic,
  domain,
  promise,
  onStart,
}: {
  topic: string;
  domain: string;
  promise: string;
  onStart: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onStart}
      className="group flex cursor-pointer flex-col gap-3.5 rounded-[var(--radius-xl)] p-2.5 text-left transition-[background-color,transform] duration-[var(--duration-base)] hover:-translate-y-0.5 hover:bg-bg-elevated hover:shadow-card"
    >
      <div className="relative aspect-video overflow-hidden rounded-[var(--radius-lg)] shadow-[var(--shadow-thumb)] transition-shadow duration-[var(--duration-base)] group-hover:shadow-[var(--shadow-thumb-hover)]">
        <BoardThumb seed={topic} className="absolute inset-0 rounded-none" />
        <span className="absolute top-2.5 left-2.5 rounded-full bg-navy-900/80 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
          {domain}
        </span>
        <span className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5 rounded-full bg-bg-elevated px-2.5 py-1 text-[12px] font-medium text-fg opacity-0 shadow-card transition-opacity group-hover:opacity-100">
          Start <ArrowRight size={12} />
        </span>
      </div>
      <div className="flex flex-col gap-1 px-1">
        <span className="text-[15.5px] font-medium leading-[1.3] tracking-[-0.01em] text-fg">
          {topic}
        </span>
        <span className="line-clamp-2 text-[13.5px] leading-[1.45] text-fg-3 text-pretty">
          {promise}
        </span>
      </div>
    </button>
  );
}
