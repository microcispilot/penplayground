import type { Expert, PlanUsage } from '@pen/contracts';
import { Chip, cn, Skeleton, useToast } from '@pen/design';
import { ArrowRight, ArrowUpRight, Mic, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, type SessionRecord } from '../api/client.js';
import { PenMark } from '../components/AppHeader.js';
import { HeroBoard } from '../components/HeroBoard.js';
import { PrivacyDialog } from '../components/PrivacyDialog.js';
import { BoardThumb, SessionCard } from '../components/SessionCard.js';
import { TOPIC_DOMAINS } from '../components/Sidebar.js';
import { markStartClicked } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';

const TRY = [
  'How Transformers work in LLMs',
  'Swift fundamentals',
  'Reading an ECG strip',
  'Rumi in Persian',
];

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
  const heroExpert = useMemo(
    () =>
      experts.find((e) => e.id === 'maya-math-professor') ??
      experts.find((e) => e.portrait) ??
      null,
    [experts],
  );
  const featured = useMemo(() => {
    // One per domain first, so the row reads as breadth, then fill to 14.
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
    return [...first, ...rest].slice(0, 14);
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
      toast(error instanceof ApiError ? error.message : 'Could not start the session', 'danger');
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
    if (!expert) return;
    setWithExpert(expert);
    setQuery((q) => (q.trim() ? q : (expert.specialties[0] ?? '')));
    inputRef.current?.focus();
    // The choice is made; a refresh or a back-navigation should not make it again.
    window.history.replaceState({}, '');
  }, [requestedExpert, expertById]);

  return (
    <div className="flex flex-1 flex-col">
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(55% 60% at 12% 0%, var(--color-wash-yellow), transparent 70%), radial-gradient(50% 60% at 88% 20%, var(--color-wash-aqua), transparent 70%), radial-gradient(70% 50% at 60% 110%, var(--color-wash-pink), transparent 70%)',
          }}
        />
        <div className="mx-auto grid w-full max-w-[1280px] items-center gap-12 px-6 pt-14 pb-24 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] lg:gap-16 lg:pt-20">
          <div className="flex min-w-0 max-w-[600px] flex-col">
            <span className="animate-rise mb-6 inline-flex w-fit items-center gap-2 rounded-full bg-bg-elevated/80 py-1.5 pr-3.5 pl-2 text-[12.5px] font-medium text-fg-2 hairline">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-presence opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-presence" />
              </span>
              Live expert · shared whiteboard · any language
            </span>
            <h1
              className="animate-rise text-[clamp(2.6rem,5.2vw,4.25rem)] leading-[0.98] tracking-[-0.035em] text-fg text-pretty"
              style={{ animationDelay: '60ms' }}
            >
              What do you want to{' '}
              <span
                className="relative inline-block text-accent-strong"
                style={{
                  fontVariationSettings: '"opsz" 96, "SOFT" 60, "WONK" 1',
                  fontStyle: 'italic',
                }}
              >
                learn
                <svg
                  viewBox="0 0 200 12"
                  className="absolute -bottom-1 left-0 h-3 w-full"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <path
                    d="M3 8 C50 2 120 10 197 4"
                    stroke="var(--color-yellow-500)"
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              ?
            </h1>
            <p
              className="animate-rise mt-6 max-w-[520px] text-[17px] leading-[1.55] text-fg-2 text-pretty"
              style={{ animationDelay: '120ms' }}
            >
              Ask for anything. An expert starts talking within seconds, writes it out on a board at
              a human pace, and stops the moment you speak.
            </p>

            <form
              className={cn(
                'animate-rise mt-9 flex min-h-[64px] w-full items-center gap-1 rounded-[20px] bg-bg-elevated p-2 pl-5 shadow-float transition-shadow duration-[var(--duration-base)]',
                'focus-within:shadow-[var(--shadow-lift),0_0_0_2px_var(--color-accent)]',
              )}
              style={{ animationDelay: '180ms' }}
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

            {waiting ? (
              <p
                className="animate-rise mt-4 text-[14px] text-fg-2 text-pretty"
                style={{ animationDelay: '240ms' }}
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
            {!waiting && usage?.remaining !== null && usage !== null ? (
              <p
                className="animate-rise mt-4 text-[14px] text-fg-3"
                style={{ animationDelay: '240ms' }}
                data-testid="home-allowance"
              >
                {usage.remaining} of {usage.sessionsPerDay} sessions left today.
              </p>
            ) : null}
            <div
              className="animate-rise mt-4 flex flex-wrap items-center gap-x-1 gap-y-1.5 text-[14px] text-fg-3"
              style={{ animationDelay: '240ms' }}
            >
              <span className="mr-1">Try</span>
              {TRY.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  className="rounded-md px-1.5 py-0.5 text-fg-2 underline decoration-line-strong decoration-[1.5px] underline-offset-[5px] transition-colors hover:bg-fg/[0.05] hover:text-fg hover:decoration-accent"
                  onClick={() => {
                    setQuery(t);
                    inputRef.current?.focus();
                  }}
                >
                  {t}
                  {i < TRY.length - 1 ? '' : ''}
                </button>
              ))}
            </div>
            <p
              className="animate-rise mt-7 text-[13px] text-fg-3"
              style={{ animationDelay: '300ms' }}
            >
              Every expert is an AI, and says so if you ask. Sessions are public; your name never
              is.
            </p>
          </div>

          <HeroBoard
            expert={heroExpert}
            portraitUrl={api.portraitUrl(heroExpert?.portrait?.src)}
            className="animate-rise mx-auto w-full min-w-0 max-w-[560px] lg:mx-0"
          />
        </div>
      </section>

      {/* ── experts ──────────────────────────────────────────────────────── */}
      <section className="border-t border-line/70 py-16">
        <div className="mx-auto w-full max-w-[1280px] px-6">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-[clamp(1.75rem,2.6vw,2.25rem)] tracking-[-0.03em]">
                Taught by experts who never lose patience.
              </h2>
              <p className="mt-2 max-w-[560px] text-[15px] text-fg-2 text-pretty">
                {experts.length > 0 ? `${experts.length} experts` : 'A hundred experts'} across
                science, code, medicine, law, money and the arts. Pick one, or let the topic choose.
              </p>
            </div>
            <span className="text-[13px] text-fg-3">They teach in your language</span>
          </div>
          <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pt-2 pb-5 [mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-56px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {experts.length === 0
              ? Array.from({ length: 8 }, (_, i) => `sk-${i}`).map((k) => (
                  <Skeleton
                    key={k}
                    className="aspect-[4/5] w-[196px] shrink-0 rounded-[var(--radius-xl)]"
                  />
                ))
              : featured.map((e) => (
                  <ExpertCard
                    key={e.id}
                    expert={e}
                    portraitUrl={api.portraitUrl(e.portrait?.src, 192)}
                    selected={withExpert?.id === e.id}
                    onChoose={() => chooseExpert(e)}
                  />
                ))}
          </div>
        </div>
      </section>

      {/* ── sessions ─────────────────────────────────────────────────────── */}
      <section className="border-t border-line/70 bg-surface/50 py-16">
        <div className="mx-auto w-full max-w-[1280px] px-6">
          <div className="mb-7 flex flex-wrap items-center gap-3">
            <h2 className="mr-2 text-[clamp(1.75rem,2.6vw,2.25rem)] tracking-[-0.03em]">
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
                <label className="flex h-9 w-[260px] shrink-0 items-center gap-2 rounded-full bg-bg-elevated px-3.5 hairline">
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
          </div>

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

      <footer className="border-t border-line/70">
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
          <span>Experts are AI. They will tell you so.</span>
          <span className="lg:hidden">© 2026 Microcis</span>
        </div>
      </footer>
      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </div>
  );
}

function ExpertCard({
  expert,
  portraitUrl,
  selected,
  onChoose,
}: {
  expert: Expert;
  portraitUrl: string | null;
  selected: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onChoose}
      className={cn(
        'group relative aspect-[4/5] w-[196px] shrink-0 overflow-hidden rounded-[var(--radius-xl)] bg-surface-2 text-left shadow-card transition-[transform,box-shadow] duration-[var(--duration-slow)] ease-[var(--ease-out)] hover:-translate-y-1 hover:shadow-lift',
        selected && 'ring-[3px] ring-accent ring-offset-2 ring-offset-bg',
      )}
    >
      {portraitUrl ? (
        <img
          src={portraitUrl}
          alt={expert.portrait?.alt ?? expert.displayName}
          loading="lazy"
          decoding="async"
          width={196}
          height={245}
          className="absolute inset-0 size-full object-cover transition-transform duration-[600ms] ease-[var(--ease-out)] group-hover:scale-[1.04]"
        />
      ) : null}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[58%]"
        style={{
          background:
            'linear-gradient(to top, oklch(0.2 0.05 248 / 92%), oklch(0.2 0.05 248 / 0%))',
        }}
      />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-4 text-white">
        <span className="text-[16px] font-medium leading-tight tracking-[-0.01em]">
          {expert.displayName}
        </span>
        <span className="line-clamp-2 text-[12.5px] leading-snug text-white/75">{expert.role}</span>
      </div>
      <span className="absolute top-3 right-3 grid size-8 place-items-center rounded-full bg-white/15 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        <ArrowUpRight size={15} />
      </span>
    </button>
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
      <div className="relative aspect-video overflow-hidden rounded-[var(--radius-lg)] shadow-[0_0_0_1px_var(--color-line)]">
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
