import type { Expert, PlanUsage } from '@pen/contracts';
import { planIncludes } from '@pen/contracts';
import { Chip, cn, Skeleton, useToast } from '@pen/design';
import { ArrowRight, Mic, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, PreparationRequired, type SessionRecord } from '../api/client.js';
import { BoardThumb, SessionCard } from '../components/SessionCard.js';
import { TOPIC_DOMAINS } from '../components/Sidebar.js';
import { markStartClicked, trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { pickTopicExample } from '../lib/topic-examples.js';

/**
 * How many faces the row carries before it hands over to the Experts page.
 * Twelve is two comfortable screens of scrolling at every width we ship; past
 * that a horizontal rail stops being a glance and becomes a chore.
 */
/** The persona the row always shows, third from the left. */

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
  /** The re-entrancy guard `starting` cannot be: state is a render, this is the same tick. */
  const startingRef = useRef(false);
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
  /**
   * The server said nobody has prepared that topic and this plan may not
   * have it prepared (ADR-0036): the sentence it sent, the way to upgrade,
   * and the lessons that are ready right now — an answer, not a closed door.
   */
  const [unprepared, setUnprepared] = useState<PreparationRequired | null>(null);
  // Once per mount. See the placeholder below for why this is not a plain call.
  const [example] = useState(pickTopicExample);

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
    trackAction('say_it_clicked', { available: recognizer.available });
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

  /**
   * Pressing Start starts a session. It is not conditional on anything this
   * screen happens to know yet.
   *
   * It used to be: `if (!participant) { toast('Connecting…'); return; }` —
   * which dropped the click for the tens of milliseconds between the shell
   * mounting and the anonymous bearer arriving, and asked the learner to
   * press it again. That window is small on a warm connection and long on a
   * cold phone, and the first thing a first-time visitor does is type and
   * press. The wait belongs in the client, where it is one in-flight promise
   * every call can join (`api/client.ts`, `identity`), not in a guard on
   * every screen that can start something.
   *
   * `startingRef` rather than the state: `starting` is what the button
   * renders, and a second click in the same frame would read the stale
   * value. The ref is written in the same tick as the check.
   */
  const start = async (topic: string, expertId?: string, source: 'box' | 'starter' = 'box') => {
    const t = topic.trim();
    if (!t || startingRef.current) return;
    // Only now is it a request: an empty box or a second press mid-start is
    // not a conversion, and used to be counted as one.
    markStartClicked();
    trackAction('start_clicked', { source, withExpert: expertId !== undefined });
    startingRef.current = true;
    setStarting(true);
    setUnprepared(null);
    try {
      const { session } = await api.createSession(expertId ? { topic: t, expertId } : { topic: t });
      navigate(`/room/${session.id}`, { state: { fresh: true } });
    } catch (error) {
      const refused =
        error instanceof ApiError && error.code === 'PREPARATION_REQUIRED'
          ? PreparationRequired.safeParse(error.detail)
          : null;
      trackAction('start_refused', {
        code: error instanceof ApiError ? error.code : 'NETWORK',
        status: error instanceof ApiError ? error.status : 0,
        source,
      });
      if (refused?.success) {
        // Said on the page, under the box the learner typed into, with the
        // lessons that are ready — not a toast that vanishes.
        setUnprepared(refused.data);
      } else {
        // A plan or a daily limit is a fact about an account, not a fault: it is
        // said in the ordinary voice. Only a real failure is a danger.
        const calm = error instanceof ApiError && error.status === 402;
        toast(
          error instanceof ApiError ? error.message : 'Could not start the session',
          calm ? 'neutral' : 'danger',
        );
      }
      startingRef.current = false;
      setStarting(false);
    }
  };

  /** True only while today's allowance or the day's capacity is used up. */
  const waiting = usage !== null && !usage.canStart;
  // What the page put in the learner's way, once per appearance: the
  // conversion that did not happen has a reason, and this is where it is said.
  const limitReason = waiting ? (usage?.reason ?? 'daily_limit') : null;
  useEffect(() => {
    if (limitReason) trackAction('limit_shown', { reason: limitReason });
  }, [limitReason]);
  const unpreparedReady = unprepared ? unprepared.ready.length : null;
  useEffect(() => {
    if (unpreparedReady !== null) trackAction('unprepared_shown', { ready: unpreparedReady });
  }, [unpreparedReady]);

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
            className="animate-rise text-headline-large text-on-surface text-balance"
            style={{ animationDelay: '40ms' }}
          >
            What do you want to learn?
          </h1>

          <form
            className={cn(
              /*
               * M3's search bar shape — `corner-full` on
               * `surface-container-high` — drawn flat.
               *
               * It used to sit on elevation level 1 and lift to level 2 on
               * focus. The owner: *"this search box is too much stand out. I
               * don't like things that are looking 3d. I like matte."* Two
               * stacked shadows under a 64 px pill is the most dimensional
               * thing on the page, and it is the first thing a visitor looks
               * at, so the page read as though the field were floating above
               * it.
               *
               * The edge is a hairline instead. Nothing here casts a shadow
               * now: the bar is told from the page by its tone and its
               * border, which is what matte means.
               */
              'animate-rise mt-10 flex min-h-[64px] w-full max-w-[720px] items-center gap-1 rounded-xl-increased border border-outline-variant bg-surface-container-high p-2 pl-5 text-left transition-colors duration-[var(--duration-base)]',
              /*
               * Focus thickens the same edge rather than adding a second
               * thing. It is deliberately **not** the brand: two pixels of
               * `primary` around this pill is the shape of a validation
               * error, and the field is focused the moment the page opens —
               * so the first thing a visitor saw was their search box
               * outlined in red for no reason. `outline` is neutral and
               * clears 3:1 on this surface, which is what a focus indicator
               * owes (WCAG 1.4.11).
               */
              'focus-within:border-outline',
            )}
            style={{ animationDelay: '160ms' }}
            onSubmit={(e) => {
              e.preventDefault();
              void start(query, withExpert?.id);
            }}
          >
            <Search size={19} className="shrink-0 text-on-surface-dim" aria-hidden />
            {withExpert ? (
              <span className="ml-2 flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary-container py-0.5 pr-1.5 pl-1 text-label-large text-on-primary-container">
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
                  className="state-layer grid size-5 place-items-center rounded-full"
                  onClick={() => {
                    trackAction('expert_cleared');
                    setWithExpert(null);
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ) : null}
            <input
              ref={inputRef}
              className="h-12 min-w-0 flex-1 bg-transparent px-3 text-body-large text-on-surface outline-none placeholder:text-on-surface-dim caret-primary"
              /*
               * One of `TOPIC_EXAMPLES`, chosen once per visit. The rules the
               * list is curated to — a subject rather than a question, no
               * quotation marks, something most people recognise, something
               * that draws well on a board — live with the list in
               * `lib/topic-examples.ts`, where a test holds every line to
               * them.
               *
               * Picked in `useState`'s initialiser, not in the body: a bare
               * `pickTopicExample()` call here would re-roll on every render,
               * so the example would flicker to a different subject on each
               * keystroke in a *different* field on the page.
               */
              placeholder={example}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="What do you want to learn?"
              // The browser's own spellchecker, which is what gives Gmail and Word
              // their red underline and right-click suggestions on the web, plus
              // the autocorrect a phone keyboard applies as you type. People
              // misspell things, and catching it at the keyboard is better than
              // catching it at retrieval: the learner sees the word is wrong and
              // fixes it, instead of the system quietly guessing what they meant.
              // Onten's per-term fuzzy matching stays as the net for what still
              // gets through.
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              // biome-ignore lint/a11y/noAutofocus: the page has one purpose and one field; focus belongs there
              autoFocus
            />
            <button
              type="button"
              title="Say it instead"
              aria-label="Say it instead"
              aria-pressed={listening}
              className={cn(
                'state-layer grid size-11 shrink-0 place-items-center rounded-full transition-colors',
                listening
                  ? 'bg-presence-container text-on-presence-container'
                  : 'text-on-surface-variant',
              )}
              onClick={listen}
            >
              <Mic size={19} />
            </button>
            <button
              type="submit"
              disabled={!query.trim() || starting || waiting}
              className="state-layer group ml-1 flex h-12 shrink-0 items-center gap-2 rounded-full bg-primary-fixed px-4 text-label-large text-on-primary-fixed sm:px-6 transition-[transform,opacity] duration-[var(--duration-fast)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-disabled"
            >
              {starting ? 'Starting…' : 'Start'}
              <ArrowRight
                size={16}
                className="transition-transform duration-[var(--duration-base)] group-hover:translate-x-0.5"
              />
            </button>
          </form>

          {/*
            The allowance only speaks when it is in the way; the running count
            is gone.

            What it offers is an action, not a sentence with a link buried in
            it. It used to end "…Standard makes them unlimited", underlined,
            inline — which names the product rather than the next step, and
            asks the learner to recognise a plan before they can tell it is the
            way forward. The owner: *"it should say something like upgrade to
            continue. And the upgrade should have a link to the subscriptions
            page."*

            So the fact stays in the ordinary voice, and the way out is a
            button under it. It is `primary-fixed` — the brand, the same fill
            as Start and Sign in — because this is the one thing to do here and
            the brand belongs in the ordinary confident places. It is not an
            alarm: nothing has gone wrong, and no `error` role appears anywhere
            near it.
          */}
          {unprepared ? (
            <div
              className="animate-rise mt-5 flex w-full max-w-[720px] flex-col items-start gap-3.5"
              data-testid="home-unprepared"
            >
              <p className="text-body-medium text-on-surface-variant text-pretty">
                {unprepared.message}
              </p>
              <Link
                to="/pricing"
                data-testid="home-upgrade"
                onClick={() => trackAction('upgrade_clicked', { source: 'home_unprepared' })}
                className="state-layer inline-flex h-10 items-center gap-2 rounded-full bg-primary-fixed px-5 text-label-large text-on-primary-fixed transition-transform duration-[var(--duration-fast)] active:scale-[0.985]"
              >
                Upgrade to continue
                <ArrowRight size={16} />
              </Link>
              {unprepared.ready.length > 0 ? (
                <div className="mt-2 flex w-full flex-col gap-3 text-left">
                  <p className="text-title-small text-on-surface">Ready now</p>
                  <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 xl:grid-cols-3">
                    {unprepared.ready.slice(0, 6).map((r) => {
                      const expert = expertById.get(r.expertId);
                      return (
                        <SessionCard
                          key={r.id}
                          session={r}
                          expertName={expert?.displayName ?? 'AI expert'}
                          portraitUrl={api.portraitUrl(expert?.portrait?.src, 192)}
                          onOpen={() => {
                            trackAction('session_opened', { sessionId: r.id, source: 'ready' });
                            navigate(`/sessions/${r.id}`);
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {waiting && !unprepared ? (
            <div
              className="animate-rise mt-5 flex max-w-[560px] flex-col items-start gap-3.5"
              style={{ animationDelay: '220ms' }}
              data-testid="home-allowance"
            >
              <p className="text-body-medium text-on-surface-variant text-pretty">
                {usage?.reason === 'capacity'
                  ? 'Free sessions are all booked for today — they open again at midnight UTC.'
                  : `That is your ${usage?.sessionsPerDay ?? 3} sessions for today. They are back at midnight UTC.`}
              </p>
              <Link
                to="/pricing"
                data-testid="home-upgrade"
                onClick={() => trackAction('upgrade_clicked', { source: 'home_limit' })}
                className="state-layer inline-flex h-10 items-center gap-2 rounded-full bg-primary-fixed px-5 text-label-large text-on-primary-fixed transition-transform duration-[var(--duration-fast)] active:scale-[0.985]"
              >
                Upgrade to continue
                <ArrowRight size={16} />
              </Link>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── sessions ─────────────────────────────────────────────────────── */}
      {/* No band and no rule: the catalogue *is* the page. */}
      <section className="py-16">
        <div className="mx-auto w-full max-w-[1280px] px-6">
          <SectionBand>
            <h2 className="mr-2 text-title-large">
              {sessions !== null && sessions.length === 0
                ? 'Start with one of these'
                : 'Most learned'}
            </h2>
            {sessions !== null && sessions.length > 0 ? (
              <>
                <div className="flex min-w-0 flex-1 gap-1.5 overflow-auto py-1">
                  {categories.map((c) => (
                    <Chip
                      key={c.id}
                      selected={category === c.id}
                      onClick={() => {
                        trackAction('topic_chosen', { topic: c.id, source: 'home' });
                        setCategory(c.id);
                      }}
                    >
                      {c.label}
                    </Chip>
                  ))}
                </div>
                <label className="flex h-9 w-full shrink-0 items-center gap-2 rounded-full bg-surface-container px-3.5 hairline sm:w-[260px]">
                  <Search size={14} className="shrink-0 text-on-surface-dim" aria-hidden />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-body-medium text-on-surface outline-none placeholder:text-on-surface-dim"
                    placeholder="Filter sessions"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter sessions"
                  />
                </label>
              </>
            ) : sessions !== null ? (
              <p className="basis-full text-body-medium text-on-surface-variant">
                Sessions people learn from most will gather here. Until then, these are prepared and
                ready to teach.
              </p>
            ) : null}
          </SectionBand>

          {/*
            Three across, and never four. This used to auto-fill at a 272 px
            minimum, which fits four inside the 1232 px content column and made
            the catalogue read as a dense grid of small pictures rather than a
            shelf of lessons.

            The breakpoints are the sidebar's, not the page's: `xl` rather than
            `lg` because at a 1024 px viewport the 240 px rail leaves ~736 px,
            and three cards there would be 232 px each — narrower than the
            272 px the card was drawn for. So two until 1280, three after.
          */}
          <div
            data-testid="catalogue"
            className="grid grid-cols-1 gap-x-5 gap-y-9 sm:grid-cols-2 xl:grid-cols-3"
          >
            {sessions === null
              ? Array.from({ length: 6 }, (_, i) => `sk-${i}`).map((k) => (
                  <div key={k} className="flex flex-col gap-3">
                    <Skeleton className="aspect-video rounded-lg" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ))
              : sessions.length === 0
                ? STARTERS.map((s) => (
                    <StarterCard
                      key={s.topic}
                      {...s}
                      onStart={() => start(s.topic, undefined, 'starter')}
                    />
                  ))
                : visible.map((s) => {
                    const expert = expertById.get(s.expertId);
                    return (
                      <SessionCard
                        key={s.id}
                        session={s}
                        expertName={expert?.displayName ?? 'AI expert'}
                        portraitUrl={api.portraitUrl(expert?.portrait?.src, 192)}
                        onOpen={() => {
                          trackAction('session_opened', { sessionId: s.id, source: 'catalogue' });
                          navigate(`/sessions/${s.id}`);
                        }}
                      />
                    );
                  })}
            {sessions !== null && sessions.length > 0 && visible.length === 0 ? (
              <div className="col-span-full flex flex-col items-center gap-1 py-16 text-center">
                <p className="text-body-large text-on-surface">No sessions match.</p>
                <p className="text-body-medium text-on-surface-variant">
                  Try another category, or clear the filter.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </section>
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
      {/*
        The legal line, and nothing else.
        
        The pane that used to sit here carried the mark, Pricing, Your sessions
        and Privacy choices as well, and the owner asked for it gone: every one
        of those is a sidebar row two inches to the left, so it was a second
        copy of the navigation stuck to the bottom of the page.
        
        What is left is `lg:hidden` and was never part of what they saw. Above
        1024 px the sidebar's own footer says these three; below it the sidebar
        is a *closed* drawer, so without this Terms would be unreachable from
        Home — and Terms is where the AI disclosure is stated. Removing the
        whole footer did exactly that, and `shell.spec.ts` caught it.
      */}
      <footer className="lg:hidden">
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-5 gap-y-2 px-6 pt-4 pb-10 text-body-medium text-on-surface-dim">
          <NavLink to="/terms" className="hover:text-on-surface">
            Terms
          </NavLink>
          <NavLink to="/privacy" className="hover:text-on-surface">
            Privacy
          </NavLink>
          <span>© 2026 Microcis</span>
        </div>
      </footer>
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
      className="group flex cursor-pointer flex-col gap-3.5 rounded-xl p-2.5 text-left transition-[background-color,transform] duration-[var(--duration-base)] hover:-translate-y-0.5 hover:bg-surface-container hover:shadow-level1"
    >
      <div className="relative aspect-video overflow-hidden rounded-lg shadow-[var(--shadow-thumb)] transition-shadow duration-[var(--duration-base)] group-hover:shadow-[var(--shadow-thumb-hover)]">
        <BoardThumb seed={topic} className="absolute inset-0 rounded-none" />
        <span className="absolute top-2.5 left-2.5 rounded-full bg-scrim/80 px-2 py-0.5 text-label-small font-medium text-white backdrop-blur">
          {domain}
        </span>
        <span className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5 rounded-full bg-surface-container px-2.5 py-1 text-body-small font-medium text-on-surface opacity-0 shadow-level1 transition-opacity group-hover:opacity-100">
          Start <ArrowRight size={12} />
        </span>
      </div>
      <div className="flex flex-col gap-1 px-1">
        <span className="text-title-small font-medium text-on-surface">{topic}</span>
        <span className="line-clamp-2 text-body-medium text-on-surface-dim text-pretty">
          {promise}
        </span>
      </div>
    </button>
  );
}
