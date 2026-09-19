import type { Expert } from '@pen/contracts';
import { cn, useModalFocus } from '@pen/design';
import {
  Bookmark,
  ChevronDown,
  Compass,
  Download,
  Heart,
  History,
  PlaySquare,
  Sparkles,
  Tag,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useLists } from '../lib/lists.js';
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

/**
 * The one row look, shared by the links and by Topics (which is not a route of
 * its own). This is M3's navigation-drawer item:
 *
 *   @material/web tokens/versions/v0_192/_md-comp-navigation-drawer.scss
 *     active indicator `secondary-container` at `corner-full`, active label
 *     and icon `on-secondary-container`, inactive `on-surface-variant`,
 *     label `label-large`.
 *
 * The filled pill *is* the indicator, which is why the tinted bar that used to
 * run down the left edge is gone: two marks for one state is one too many.
 */
function rowClass(rail: boolean, active: boolean): string {
  return cn(
    'state-layer group relative flex items-center gap-3.5 rounded-full transition-colors duration-[var(--duration-fast)]',
    rail ? 'mx-1 flex-col gap-1.5 px-0.5 py-3 text-center' : 'h-10 px-4',
    active ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant',
  );
}

/** The label: full width on the rail so a long one truncates instead of bleeding out. */
function RowLabel({ rail, children }: { rail: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'min-w-0 truncate',
        rail ? 'w-full text-label-small leading-tight' : 'flex-1 text-label-large',
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
      {() => (
        <>
          <span className="grid shrink-0 place-items-center">{icon}</span>
          <RowLabel rail={rail}>{rail ? (railLabel ?? label) : label}</RowLabel>
          {!rail && tag ? (
            // The plan a row belongs to, as a label rather than a second piece
            // of prose. M3's badge shape — a filled tonal pill at
            // `label-small`, the smallest role in the scale — so it reads as a
            // marker beside the row's name and never competes with it.
            <span className="shrink-0 rounded-full bg-surface-container-highest px-2 py-0.5 text-label-small font-normal text-on-surface-variant">
              {tag}
            </span>
          ) : null}
          {!rail && tag === undefined && count !== undefined && count > 0 ? (
            <span className="shrink-0 text-label-medium text-on-surface-variant tabular">
              {count}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function SectionLabel({ children, rail }: { children: ReactNode; rail: boolean }) {
  if (rail) return null;
  return (
    <div className="px-4 pt-4 pb-1.5 text-label-small tracking-wider text-on-surface-variant uppercase">
      {children}
    </div>
  );
}

/** A quiet horizontal rule between sections. */
function Divider() {
  return <div className="my-2 border-t border-outline-variant" aria-hidden />;
}

/**
 * The shell's left sidebar (ADR-0015): what the platform has, in the order a
 * learner reaches for it. Learn is for everyone; You is the learner's own
 * shelf — the same rows whether or not they have signed in, because an
 * anonymous participant really does have sessions, saves and likes on this
 * device.
 *
 * It is navigation and nothing else. Identity belongs to the header's account
 * chip, the one place a learner looks for themselves; pace belongs to the
 * session being taught, where it is felt, and is kept on the account from
 * there (ADR-0010). What is left here is Theme — the one preference that is
 * about the app rather than about a lesson.
 */
export function Sidebar({ rail = false, onNavigate, className }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const counts = useLists((s) => s.counts);
  const [topicsOpen, setTopicsOpen] = useState(() =>
    new URLSearchParams(location.search).has('topic'),
  );
  const activeTopic = new URLSearchParams(location.search).get('topic');

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
              className={rowClass(false, false)}
            >
              <Tag size={19} className="shrink-0" />
              <span className="flex-1 text-left text-label-large">Topics</span>
              <ChevronDown
                size={15}
                className={cn(
                  'shrink-0 text-on-surface-dim transition-transform duration-[var(--duration-base)]',
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
                      'state-layer rounded-full px-4 py-1.5 text-left text-label-large transition-colors',
                      activeTopic === d.id
                        ? 'bg-secondary-container text-on-secondary-container'
                        : 'text-on-surface-variant',
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
      </div>

      <span className="flex-1" />
      {rail ? null : <SidebarFooter onNavigate={onNavigate} />}
    </nav>
  );
}

function SidebarFooter({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  return (
    <div
      className="mt-6 flex flex-col gap-2 border-t border-outline-variant px-4 pt-4 text-body-small text-on-surface-dim"
      data-testid="sidebar-footer"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <NavLink to="/terms" onClick={onNavigate} className="hover:text-on-surface">
          Terms
        </NavLink>
        <span aria-hidden>·</span>
        <NavLink to="/privacy" onClick={onNavigate} className="hover:text-on-surface">
          Privacy
        </NavLink>
      </div>
      {/* The AI line moved to the Terms page, where it is stated in full; the
          copyright takes the place it had, so the footer keeps its two lines. */}
      <p className="leading-[1.5]">© 2026 Microcis</p>
    </div>
  );
}

/**
 * The small-screen drawer: the same sidebar over a scrim, opened from the
 * header's menu button. It claims `aria-modal`, so it owes what that promises —
 * Escape closes it, focus moves in and cannot Tab out behind the scrim, and it
 * returns to the menu button on close. That contract lives in `useModalFocus`
 * (the same one the design system's `Sheet` uses); the only thing left here is
 * the page behind not scrolling while it is up.
 */
export function SidebarDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, onClose, panelRef);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden" data-testid="sidebar-drawer">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close the sidebar"
        className="absolute inset-0 w-full cursor-default bg-scrim/45 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Sections"
        // M3 modal navigation drawer: `surface-container-low`, `corner-large` on
        // the trailing edge only, elevation level 1 over the scrim.
        className="animate-rise absolute inset-y-0 left-0 w-[268px] rounded-e-lg bg-surface-container-low shadow-level1 outline-none"
      >
        <div className="flex h-16 items-center gap-2 px-5">
          <PenMark />
          <span className="font-display text-title-large font-medium tracking-[-0.03em]">Pen</span>
        </div>
        <Sidebar className="h-[calc(100%-4rem)]" onNavigate={onClose} />
      </div>
    </div>
  );
}
