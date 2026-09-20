import { cn } from '@pen/design';
import { NavLink, Outlet, useLocation, useOutletContext, useSearchParams } from 'react-router';
import { ConsolePage } from '../../shell/AdminShell.js';
import { RangeControl } from './RangeControl.js';
import { type RangeController, useRange } from './use-range.js';

/**
 * Statistics (ADR-0027, ADR-0028).
 *
 * **Why seven pages and not one, and not thirteen.** The reporting API has
 * thirteen endpoints, and neither extreme is the right shape for them. One
 * scrolling page would put the cost of a lesson, a cohort grid and a list of
 * browsers in the same breath. A page per endpoint would leave several of
 * them holding six numbers.
 *
 * So the section is cut by the *question being asked*, and each page is one
 * question with everything that answers it:
 *
 *   Overview  — the headline, and the way in to the other six.
 *   Money     — what the product spends and what it earns   (`cost`, `plans`)
 *   Sessions  — one lesson at a time    (`sessions`, `sessions/:id`, `reuse`)
 *   Pipeline  — where time and money go inside a lesson, where it fails,
 *               and where the learner stopped     (`stages`, `abandonment`)
 *   People    — who they are and whether they come back  (`users`, `retention`)
 *   Visits    — what happens on the site, signed in or not        (`visits`)
 *   Audience  — where they are, on what, and when   (`geography`, `devices`, `clock`)
 *
 * `reuse/:id` is the one route with no page of its own, on purpose: the whole
 * of what it answers — "reused fourteen times, and here are the searches" —
 * already arrives with `sessions/:id`, which returns the same block plus
 * everything else about that lesson. `reuse` itself ranks the lessons others
 * lean on, at the top of Sessions; its totals are on Overview.
 *
 * The range control is here rather than on each page, because it belongs to
 * all of them: moving from Money to Visits must not silently change the
 * window the numbers describe.
 */

interface Tab {
  /** Relative to `/statistics`. The overview is the index. */
  to: string;
  label: string;
  /** Whether anything on this page reads `bucket`, so the control appears only where it acts. */
  bucket: boolean;
  end?: boolean;
}

const TABS: Tab[] = [
  { to: '.', label: 'Overview', bucket: false, end: true },
  { to: 'money', label: 'Money', bucket: true },
  { to: 'sessions', label: 'Sessions', bucket: false },
  { to: 'pipeline', label: 'Pipeline', bucket: false },
  { to: 'people', label: 'People', bucket: true },
  { to: 'visits', label: 'Visits', bucket: true },
  { to: 'audience', label: 'Audience', bucket: false },
];

export interface StatisticsContext {
  range: RangeController;
}

/** The range every statistics page reads. Throws nowhere: the shell always provides it. */
export function useStatisticsRange(): RangeController {
  return useOutletContext<StatisticsContext>().range;
}

/**
 * What a tab link carries across with it.
 *
 * The range belongs to the whole section, so moving from Money to Visits
 * must not silently widen the window back to thirty days — but a filter
 * belongs to the page that owns it, and carrying `plan=free&page=4` onto a
 * page with neither would be worse than dropping it.
 */
const SECTION_PARAMS = ['range', 'from', 'to', 'bucket'] as const;

function carried(params: URLSearchParams): string {
  const next = new URLSearchParams();
  for (const name of SECTION_PARAMS) {
    const value = params.get(name);
    if (value !== null) next.set(name, value);
  }
  const search = next.toString();
  return search ? `?${search}` : '';
}

export function Statistics() {
  const range = useRange();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const search = carried(params);
  const active =
    TABS.slice(1).find((tab) => pathname.startsWith(`/statistics/${tab.to}`)) ?? TABS[0];

  return (
    <ConsolePage
      title="Statistics"
      width="wide"
      intro="The product's own numbers: what a lesson costs, what gets reused, where learners stop, and who is out there — including everybody who never signs in. Errors and event streams stay with Sentry and PostHog; this is the money, the reuse, the retention and the audience."
    >
      <div className="flex flex-col gap-4">
        <nav
          aria-label="Statistics"
          className="-mx-1 flex gap-1 overflow-x-auto border-outline-variant border-b px-1"
          data-testid="statistics-tabs"
        >
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={`${tab.to}${search}`}
              end={tab.end ?? false}
              className={({ isActive }) =>
                cn(
                  'state-layer -mb-px shrink-0 rounded-t-sm border-b-2 px-3 py-2 text-label-large transition-colors',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-on-surface-variant',
                )
              }
              data-testid={`tab-${tab.to === '.' ? 'overview' : tab.to}`}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <RangeControl controller={range} showBucket={active?.bucket ?? false} />
      </div>

      <Outlet context={{ range } satisfies StatisticsContext} />
    </ConsolePage>
  );
}

/** A page's own one-line answer to "what am I looking at". */
export function PageLead({ children }: { children: React.ReactNode }) {
  return <p className="-mt-2 max-w-[80ch] text-body-medium text-on-surface-variant">{children}</p>;
}
