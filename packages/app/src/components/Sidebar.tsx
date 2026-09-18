import type { Expert } from '@pen/contracts';
import { formatPace, PACE_PRESETS } from '@pen/contracts';
import { cn } from '@pen/design';
import {
  Bookmark,
  ChevronDown,
  Compass,
  Download,
  Gauge,
  Heart,
  History,
  Moon,
  PlaySquare,
  Sparkles,
  Sun,
  Tag,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useApp } from '../lib/context.js';
import { useLists } from '../lib/lists.js';
import { readPacePreference, writePacePreference } from '../lib/pace-preference.js';
import { isDarkTheme, useTheme } from '../lib/theme.js';
import { PenMark } from './AppHeader.js';

/** The domains the catalog teaches, in the order the sidebar lists them. */
export const TOPIC_DOMAINS: { id: Expert['domain']; label: string }[] = [
  { id: 'computing-data', label: 'Computing' },
  { id: 'math-science-engineering', label: 'Science' },
  { id: 'business-finance-career', label: 'Finance' },
  { id: 'health-law-civics', label: 'Health & Law' },
  { id: 'humanities-languages', label: 'Humanities' },
  { id: 'arts-design', label: 'Design' },
  { id: 'life-skills', label: 'Life skills' },
  { id: 'learning-and-careers', label: 'Learning' },
];

export interface SidebarProps {
  /** 72 px icon rail instead of the 240 px list. */
  rail?: boolean;
  /** Inside the small-screen drawer: always the full list, and every link closes it. */
  onNavigate?: () => void;
  className?: string;
}

interface RowProps {
  to: string;
  icon: ReactNode;
  label: string;
  rail: boolean;
  /** A shorter word for the 72 px rail; the full label is the tooltip. */
  railLabel?: string;
  /** Only when the route is exactly this one (Home). */
  end?: boolean;
  /** A number beside the label; hidden on the rail. */
  count?: number | undefined;
  /** "Standard" / "Professional": what the row belongs to, never a warning. */
  tag?: string | undefined;
  onNavigate?: (() => void) | undefined;
}

/** The one row look, shared by the links and by Topics (which is not a route of its own). */
function rowClass(rail: boolean, active: boolean): string {
  return cn(
    'group relative flex items-center gap-3.5 rounded-[var(--radius-md)] transition-colors duration-[var(--duration-fast)]',
    rail ? 'mx-1 flex-col gap-1.5 px-0.5 py-3 text-center' : 'px-3 py-2',
    active ? 'bg-accent-soft text-accent-strong' : 'text-fg-2 hover:bg-fg/[0.05] hover:text-fg',
  );
}

/** The tinted bar down the left edge of the active row (expanded only). */
function ActiveMark() {
  return (
    <span
      aria-hidden
      className="absolute top-1.5 bottom-1.5 -left-2 w-[3px] rounded-full bg-accent-strong"
    />
  );
}

/** The label: full width on the rail so a long one truncates instead of bleeding out. */
function RowLabel({ rail, children }: { rail: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'min-w-0 truncate',
        rail ? 'w-full text-[10px] leading-tight' : 'flex-1 text-[14px] font-medium',
      )}
    >
      {children}
    </span>
  );
}

/**
 * One navigation row. Expanded: icon, label, and (when there is something to
 * say) a count or a plan tag. Rail: the icon with its label underneath, the way
 * a mini guide reads.
 */
function Row({ to, icon, label, rail, railLabel, end = false, count, tag, onNavigate }: RowProps) {
  return (
    <NavLink
      to={to}
      end={end}
      title={rail ? label : undefined}
      onClick={onNavigate}
      className={({ isActive }) => rowClass(rail, isActive)}
    >
      {({ isActive }) => (
        <>
          {!rail && isActive ? <ActiveMark /> : null}
          <span className="grid shrink-0 place-items-center">{icon}</span>
          <RowLabel rail={rail}>{rail ? (railLabel ?? label) : label}</RowLabel>
          {!rail && tag ? (
            <span className="shrink-0 text-[11px] font-medium text-fg-3">{tag}</span>
          ) : null}
          {!rail && tag === undefined && count !== undefined && count > 0 ? (
            <span className="shrink-0 text-[12px] text-fg-3 tabular">{count}</span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function SectionLabel({ children, rail }: { children: ReactNode; rail: boolean }) {
  if (rail) return null;
  return (
    <div className="px-3 pt-4 pb-1.5 text-[11px] font-semibold tracking-[0.07em] text-fg-3 uppercase">
      {children}
    </div>
  );
}

/** A quiet horizontal rule between sections. */
function Divider() {
  return <div className="my-2 border-t border-line" aria-hidden />;
}

/**
 * The shell's left sidebar (ADR-0015): what the platform has, in the order a
 * learner reaches for it. Learn is for everyone; You is the learner's own
 * shelf — the same rows whether or not they have signed in, because an
 * anonymous participant really does have sessions, saves and likes on this
 * device. Settings are the two preferences that change how a lesson feels.
 */
export function Sidebar({ rail = false, onNavigate, className }: SidebarProps) {
  const { participant, platform } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const counts = useLists((s) => s.counts);
  const [theme, setTheme] = useTheme();
  const dark = isDarkTheme(theme);
  const [topicsOpen, setTopicsOpen] = useState(() =>
    new URLSearchParams(location.search).has('topic'),
  );
  const [pace, setPace] = useState(() => readPacePreference(platform.storage) ?? 1);
  const activeTopic = new URLSearchParams(location.search).get('topic');
  const signedIn = participant !== null && !participant.anonymous;

  return (
    <nav
      aria-label="Sections"
      data-testid="sidebar"
      data-rail={rail || undefined}
      className={cn(
        'flex h-full flex-col overflow-y-auto overflow-x-hidden overscroll-contain pb-4 [scrollbar-width:thin]',
        rail ? 'w-[72px] px-0.5' : 'w-[240px] px-3',
        className,
      )}
    >
      <div className={cn('flex flex-col', rail ? 'gap-0' : 'gap-0.5 pt-3')}>
        <SectionLabel rail={rail}>Learn</SectionLabel>
        <Row
          to="/"
          end
          icon={<Compass size={19} />}
          label="Home"
          rail={rail}
          onNavigate={onNavigate}
        />
        <Row
          to="/experts"
          icon={<Users size={19} />}
          label="Experts"
          rail={rail}
          onNavigate={onNavigate}
        />
        {rail ? (
          <button
            type="button"
            title="Topics"
            aria-current={activeTopic ? 'page' : undefined}
            className={rowClass(true, activeTopic !== null)}
            onClick={() => {
              navigate(`/?topic=${activeTopic ?? TOPIC_DOMAINS[0]?.id ?? 'computing-data'}`);
              onNavigate?.();
            }}
          >
            <span className="grid shrink-0 place-items-center">
              <Tag size={19} />
            </span>
            <RowLabel rail>Topics</RowLabel>
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={topicsOpen}
              onClick={() => setTopicsOpen((v) => !v)}
              className="flex items-center gap-3.5 rounded-[var(--radius-md)] px-3 py-2 text-fg-2 transition-colors duration-[var(--duration-fast)] hover:bg-fg/[0.05] hover:text-fg"
            >
              <Tag size={19} className="shrink-0" />
              <span className="flex-1 text-left text-[14px] font-medium">Topics</span>
              <ChevronDown
                size={15}
                className={cn(
                  'shrink-0 text-fg-3 transition-transform duration-[var(--duration-base)]',
                  topicsOpen && 'rotate-180',
                )}
              />
            </button>
            {topicsOpen ? (
              <div className="flex flex-col gap-0.5 pt-0.5 pb-1 pl-[26px]">
                {TOPIC_DOMAINS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      navigate(`/?topic=${d.id}`);
                      onNavigate?.();
                    }}
                    className={cn(
                      'rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-[13px] transition-colors',
                      activeTopic === d.id
                        ? 'bg-accent-soft font-medium text-accent-strong'
                        : 'text-fg-2 hover:bg-fg/[0.05] hover:text-fg',
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
        <Row
          to="/pricing"
          icon={<Sparkles size={19} />}
          label="Pricing"
          rail={rail}
          onNavigate={onNavigate}
        />

        <Divider />
        <SectionLabel rail={rail}>You</SectionLabel>
        <Row
          to="/history"
          icon={<History size={19} />}
          label="History"
          rail={rail}
          count={counts.history}
          onNavigate={onNavigate}
        />
        <Row
          to="/saved"
          icon={<Bookmark size={19} />}
          label="Learn later"
          railLabel="Later"
          rail={rail}
          count={counts.saved}
          onNavigate={onNavigate}
        />
        <Row
          to="/liked"
          icon={<Heart size={19} />}
          label="Liked"
          rail={rail}
          count={counts.liked}
          onNavigate={onNavigate}
        />
        <Row
          to="/sessions"
          icon={<PlaySquare size={19} />}
          label="Your sessions"
          railLabel="Sessions"
          rail={rail}
          count={counts.hosted}
          onNavigate={onNavigate}
        />
        <Row
          to="/downloads"
          icon={<Download size={19} />}
          label="Downloads"
          rail={rail}
          tag="Standard"
          onNavigate={onNavigate}
        />
        <Row
          to="/rooms"
          icon={<Users size={19} />}
          label="Rooms"
          rail={rail}
          tag="Professional"
          onNavigate={onNavigate}
        />
        {!signedIn && !rail ? <SignInRow onNavigate={onNavigate} /> : null}

        {rail ? null : (
          <>
            <Divider />
            <SectionLabel rail={rail}>Settings</SectionLabel>
            <button
              type="button"
              data-testid="sidebar-theme"
              onClick={() => setTheme(dark ? 'light' : 'dark')}
              className="flex items-center gap-3.5 rounded-[var(--radius-md)] px-3 py-2 text-fg-2 transition-colors duration-[var(--duration-fast)] hover:bg-fg/[0.05] hover:text-fg"
            >
              {dark ? (
                <Sun size={19} className="shrink-0" />
              ) : (
                <Moon size={19} className="shrink-0" />
              )}
              <span className="flex-1 text-left text-[14px] font-medium">Theme</span>
              <span className="text-[12px] text-fg-3">{dark ? 'Dark' : 'Light'}</span>
            </button>
            {/* A native select keeps the keyboard and the screen reader happy; only its chrome is ours. */}
            <div className="group flex items-center gap-3.5 rounded-[var(--radius-md)] px-3 py-2 text-fg-2 transition-colors duration-[var(--duration-fast)] focus-within:bg-fg/[0.05] hover:bg-fg/[0.05] hover:text-fg">
              <Gauge size={19} className="shrink-0" />
              <label htmlFor="sidebar-pace" className="flex-1 text-[14px] font-medium">
                Pace
              </label>
              <span className="relative flex items-center text-[12px] text-fg-3">
                <select
                  id="sidebar-pace"
                  data-testid="sidebar-pace"
                  value={String(pace)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setPace(next);
                    writePacePreference(platform.storage, next);
                  }}
                  className="cursor-pointer appearance-none rounded-[var(--radius-sm)] bg-transparent py-0.5 pr-4 pl-1 text-right text-inherit outline-none"
                >
                  {PACE_PRESETS.map((p) => (
                    <option key={p} value={String(p)}>
                      {formatPace(p)}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={12}
                  aria-hidden
                  className="pointer-events-none absolute right-0"
                />
              </span>
            </div>
          </>
        )}
      </div>

      <span className="flex-1" />
      {rail ? null : <SidebarFooter onNavigate={onNavigate} />}
    </nav>
  );
}

/** A quiet invitation, not a wall: one row, the same weight as the others. */
function SignInRow({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="sidebar-signin"
      onClick={() => {
        navigate('/', { state: { signIn: true } });
        onNavigate?.();
      }}
      className="mt-1 flex items-center gap-3.5 rounded-[var(--radius-md)] px-3 py-2 text-left text-accent-strong transition-colors duration-[var(--duration-fast)] hover:bg-accent-soft"
    >
      <PenMark size={19} className="shrink-0" />
      <span className="flex-1 text-[14px] font-medium">Sign in</span>
    </button>
  );
}

function SidebarFooter({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  return (
    <div
      className="mt-6 flex flex-col gap-2 border-t border-line px-3 pt-4 text-[12px] text-fg-3"
      data-testid="sidebar-footer"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <NavLink to="/terms" onClick={onNavigate} className="hover:text-fg">
          Terms
        </NavLink>
        <span aria-hidden>·</span>
        <NavLink to="/privacy" onClick={onNavigate} className="hover:text-fg">
          Privacy
        </NavLink>
      </div>
      <p className="leading-[1.5]">Experts are AI.</p>
      <p className="leading-[1.5]">© 2026 Microcis</p>
    </div>
  );
}

/**
 * The small-screen drawer: the same sidebar over a scrim, opened from the
 * header's menu button. Escape closes it, focus moves in, and the page behind
 * does not scroll while it is open.
 */
export function SidebarDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden" data-testid="sidebar-drawer">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close the sidebar"
        className="absolute inset-0 w-full cursor-default bg-navy-900/45 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Sections"
        className="animate-rise absolute inset-y-0 left-0 w-[268px] bg-bg-elevated shadow-pop outline-none"
      >
        <div className="flex h-16 items-center gap-2 px-5">
          <PenMark />
          <span className="font-display text-[19px] font-medium tracking-[-0.03em]">Pen</span>
        </div>
        <Sidebar className="h-[calc(100%-4rem)]" onNavigate={onClose} />
      </div>
    </div>
  );
}
