import type { Expert } from '@pen/contracts';
import { cn, PenLogo, useModalFocus } from '@pen/design';
import {
  Bookmark,
  ChevronDown,
  Compass,
  Download,
  Heart,
  History,
  MessageSquareText,
  PlaySquare,
  Settings2,
  Sparkles,
  Tag,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useLists } from '../lib/lists.js';

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
  /** 80 px icon rail instead of the 256 px list. */
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
  /** A shorter word for the rail; the full label is the tooltip. */
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
 *
 * The rail is the exception, on the owner's instruction: *"when the side bar
 * is collapsed the selected item should not have a background different from
 * others, only the foreground should be different and probably the primary
 * color."* And it is the better shape there for a reason the expanded list
 * does not have — an 80 px rail row is nearly square and its pill lands as a
 * heavy tinted block with an icon floating in it, where the same pill beside
 * a 256 px label reads as an underline would. So the rail says "here" in the
 * ink alone, at `primary`, which is the brand red the rest of the product
 * uses for the ordinary confident places.
 */
function rowClass(rail: boolean, active: boolean): string {
  return cn(
    // Flush on the left, a 1 px corner on the right: the fill runs off the sidebar's edge and
    // ends softly (the owner, 2026-09-26: "put 1px corner radius on the right, not the left").
    'state-layer group relative flex items-center rounded-l-none rounded-r-[1px] transition-colors duration-[var(--duration-fast)]',
    // gap-3: a step in from the 3.5 this carried, so the label sits with its
    // icon rather than across a gutter from it.
    rail ? 'flex-col gap-1.5 px-0.5 py-3 text-center' : 'h-10 gap-3 pl-7 pr-4',
    // The current row sits on the lightest surface step with the brand as its ink, icon and
    // label alike, flush with the sidebar's left edge. The owner's choice (2026-09-26) after
    // the brand as fill at several strengths and a rose tint: "use the previous one with
    // foreground as the primary brand color". The brand on that step reads 5.4:1 by day and
    // 2.5:1 by night; the owner chose it knowing the row is a label, not prose.
    active ? 'bg-surface-container-highest text-brand' : 'text-on-surface-variant',
  );
}

/**
 * The label: full width on the rail so a long one truncates instead of
 * bleeding out.
 *
 * `font-semibold` over the role's own 500 — the owner asked for it, and a
 * navigation label is a destination rather than prose, so it can carry the
 * extra weight without shouting. It costs a little width, which is part of
 * why the expanded sidebar went to 256 px: "Downloads" was reaching the
 * ellipsis beside its plan tag at 240.
 */
function RowLabel({ rail, children }: { rail: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'min-w-0 truncate font-semibold',
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
      onClick={() => {
        trackAction('nav_clicked', { to, rail });
        onNavigate?.();
      }}
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
            <span className="shrink-0 rounded-full bg-surface-container-highest px-1.5 py-px text-label-tiny font-normal text-on-surface-variant">
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
    <div className="pl-7 pr-4 pt-4 pb-1.5 text-label-small tracking-wider text-on-surface-variant uppercase">
      {children}
    </div>
  );
}

/** A quiet horizontal rule between sections. */
function Divider() {
  return <div className="my-2 ml-3 border-t border-outline-variant" aria-hidden />;
}

/**
 * The rail is 80 px, not the 72 it was, and its rows run edge to edge.
 *
 * `Downloads` is the longest label in the list that has no shorter form —
 * `Learn later` becomes `Later` and `Your sessions` becomes `Sessions`, but a
 * download is not called anything else — and at 72 px with the labels now
 * semibold it truncated to `Downlo…`, which is what the owner saw. The ways
 * out were to invent a second name for a destination or to make the box fit
 * the word. The second does not teach a learner two words for one place.
 *
 * Both numbers are measured rather than judged. At 80 px with `mx-1` the label
 * box is 64 px and `Downloads` lays out at 65 — clipped by a single pixel,
 * which is all an ellipsis needs. 80 is what M3 specifies for a navigation
 * rail, so the last four came off the row's own margin instead, leaving 68
 * against the 65 the longest label wants. `tmp` measurement, Chromium, 11 px
 * at weight 600 with 0.5 px tracking: every other label lays out at 64 or
 * less, so nothing else was near the edge.
 *
 * The shell's left sidebar (ADR-0015): what the platform has, in the order a
 * learner reaches for it. Learn is for everyone; You is the learner's own
 * shelf, and it exists only once they have an account (ADR-0040) — a visitor
 * sees Learn and Settings and nothing that asks them for anything.
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
  const { features } = useApp();
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
        // No left inset: the current row's fill runs to the sidebar's left edge (the owner,
        // 2026-09-26: "the background should go all the way to the left edge"); the content
        // keeps its place through the rows' own left padding.
        rail ? 'w-[5rem]' : 'w-[16rem] pr-3',
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
              // On the rail there is no list: the button is a way to the
              // topics, and a way back out of one.
              const topic = activeTopic ? 'all' : (TOPIC_DOMAINS[0]?.id ?? 'computing-data');
              trackAction('topic_chosen', { topic, source: 'rail' });
              navigate(topic === 'all' ? '/' : `/?topic=${topic}`);
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
              <span className="flex-1 text-left text-label-large font-semibold">Topics</span>
              <ChevronDown
                size={15}
                className={cn(
                  'shrink-0 text-on-surface-dim transition-transform duration-[var(--duration-base)]',
                  topicsOpen && 'rotate-180',
                )}
              />
            </button>
            {topicsOpen ? (
              <div className="flex flex-col gap-0.5 pt-0.5 pb-1">
                {/* The way back. A topic chosen here filtered Home with no row to
                    un-choose it (the owner, 2026-09-23); this is the chips' "All",
                    where the topics are. */}
                <button
                  type="button"
                  onClick={() => {
                    trackAction('topic_chosen', { topic: 'all', source: 'sidebar' });
                    navigate('/');
                    onNavigate?.();
                  }}
                  className={cn(
                    'state-layer rounded-l-none rounded-r-[1px] pl-[3.375rem] pr-4 py-1.5 text-left text-label-large transition-colors',
                    activeTopic === null && location.pathname === '/'
                      ? 'bg-surface-container-highest text-brand'
                      : 'text-on-surface-variant',
                  )}
                  data-testid="sidebar-topic-all"
                >
                  All topics
                </button>
                {TOPIC_DOMAINS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      trackAction('topic_chosen', { topic: d.id, source: 'sidebar' });
                      navigate(`/?topic=${d.id}`);
                      onNavigate?.();
                    }}
                    className={cn(
                      'state-layer rounded-l-none rounded-r-[1px] pl-[3.375rem] pr-4 py-1.5 text-left text-label-large transition-colors',
                      activeTopic === d.id
                        ? 'bg-surface-container-highest text-brand'
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

        {/*
          A visitor without an account has no shelf, and no section about one
          (ADR-0040, the owner on 2026-09-23: "that entire block for the
          sidebar should be gone in anonymous"). The way in is the header's
          two doors; the shelf appears the moment they are through.
        */}
        {features.history ? (
          <>
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
          </>
        ) : null}

        <Divider />
        {/*
          Settings is its own section of one, not a row under "You".
          "You" is the learner's shelf — the sessions, saves and likes that are
          *theirs*. Settings is about the app, which is a different kind of
          thing, and burying it among the shelves is how a preference screen
          ends up unfindable.
        */}
        <Row
          to="/settings"
          icon={<Settings2 size={19} />}
          label="Settings"
          rail={rail}
          onNavigate={onNavigate}
        />
        {/* Feedback and support (ADR-0060): an issue, an idea, a feature, or a word to us. */}
        <Row
          to="/feedback"
          icon={<MessageSquareText size={19} />}
          label="Feedback"
          rail={rail}
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
      className="mt-6 ml-3 flex flex-col gap-2 border-t border-outline-variant pl-4 pr-4 pt-4 text-body-small text-on-surface-dim"
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
        <span aria-hidden>·</span>
        <NavLink to="/feedback?kind=contact" onClick={onNavigate} className="hover:text-on-surface">
          Contact
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
        // The same surface as the shell's sidebar, which below 1024 px this
        // *is* — so it follows the same instruction. M3 would put a modal
        // drawer on `surface-container-low`; here the scrim and level-1
        // elevation already separate it from the page, and a second grey would
        // make the drawer a different sidebar from the one at desktop width.
        // `corner-large` on the trailing edge only.
        className="animate-rise absolute inset-y-0 left-0 w-[16.75rem] rounded-e-lg bg-surface-container-lowest shadow-level1 outline-none"
      >
        <div className="flex h-16 items-center gap-2 px-5">
          {/* The drawer has no header above it, so this is the one place the
              lockup carries the product's name rather than repeating it. */}
          <PenLogo title="Pen Playground" />
        </div>
        <Sidebar className="h-[calc(100%-4rem)]" onNavigate={onClose} />
      </div>
    </div>
  );
}
