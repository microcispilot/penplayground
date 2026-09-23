import { Button, cn } from '@pen/design';
import type { LucideIcon } from 'lucide-react';
import { BarChart3, LogOut, PenLine, SlidersHorizontal, ToggleRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAdmin } from '../lib/context.js';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

/**
 * The console's navigation. One array, so a page that lands next week is one
 * line here and nothing else (ADR-0026). Statistics is a section rather than
 * a page: the link lands on its overview and the section carries its own tabs.
 */
const NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
  { to: '/features', label: 'Features', icon: ToggleRight },
  { to: '/statistics', label: 'Statistics', icon: BarChart3 },
];

export function AdminShell() {
  const { session, signOut } = useAdmin();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-dvh bg-surface">
      <aside
        className="sticky top-0 flex h-dvh w-16 shrink-0 flex-col border-outline-variant border-r bg-surface-container-low sm:w-60"
        aria-label="Console navigation"
        data-testid="admin-nav"
      >
        <div className="flex h-16 items-center gap-2.5 border-outline-variant border-b px-4">
          <PenLine size={20} className="shrink-0 text-primary" aria-hidden />
          <span className="hidden text-title-medium text-on-surface sm:inline">Operations</span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end ?? false}
                // Below `sm` the label is hidden and the icon is aria-hidden,
                // so without this the link is announced with no name at all.
                aria-label={item.label}
                title={item.label}
                className={({ isActive }) =>
                  cn(
                    'state-layer flex h-11 items-center justify-center gap-3 rounded-full px-3 text-label-large transition-colors sm:justify-start',
                    isActive
                      ? 'bg-secondary-container text-on-secondary-container'
                      : 'text-on-surface-variant',
                  )
                }
              >
                <Icon size={19} className="shrink-0" aria-hidden />
                <span className="hidden sm:inline">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="border-outline-variant border-t p-3">
          <p className="mb-2 hidden truncate text-body-small text-on-surface-variant sm:block">
            {session.admin ? session.email : ''}
          </p>
          <Button
            variant="ghost"
            className="w-full justify-center sm:justify-start"
            leading={<LogOut size={18} aria-hidden />}
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              signOut();
              navigate('/sign-in', { replace: true });
            }}
            data-testid="sign-out"
          >
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-8 sm:px-10">
        <Outlet />
      </main>
    </div>
  );
}

/** The page frame every console page sits in: a title, a sentence, and the work. */
export function ConsolePage({
  title,
  intro,
  actions,
  width = 'default',
  children,
}: {
  title: string;
  intro?: ReactNode;
  actions?: ReactNode;
  /**
   * `wide` is for the statistics pages and only for them: a cohort grid and
   * a session table have columns that a 1000 px measure turns into a
   * horizontal scrollbar on a desktop. Prose stays at `default`, because a
   * paragraph 1280 px wide is unreadable however much room there is.
   */
  width?: 'default' | 'wide';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-7',
        width === 'wide' ? 'max-w-[1280px]' : 'max-w-[1000px]',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[62ch]">
          <h1 className="text-headline-small text-on-surface">{title}</h1>
          {intro ? <p className="mt-2 text-body-medium text-on-surface-variant">{intro}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
