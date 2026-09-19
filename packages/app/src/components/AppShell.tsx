import { cn } from '@pen/design';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useApp } from '../lib/context.js';
import { useLists } from '../lib/lists.js';
import { readSidebarPreference, writeSidebarPreference } from '../lib/sidebar-preference.js';
import { AppHeader } from './AppHeader.js';
import { Sidebar, SidebarDrawer } from './Sidebar.js';

/**
 * The app shell (ADR-0015): header, the persistent left sidebar, and the
 * screen itself. Wide screens keep the sidebar in the layout — 240 px, or the
 * 72 px icon rail the learner chose, remembered across visits; under 1024 px
 * it becomes a drawer opened from the header's menu button. The room and the
 * replay are not shells: there the board is the whole screen.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { platform, participant, api } = useApp();
  const location = useLocation();
  const [rail, setRail] = useState(() => readSidebarPreference(platform.storage) === 'rail');
  const [drawer, setDrawer] = useState(false);
  const loadLists = useLists((s) => s.load);

  // The lists are the sidebar's counts and every card's heart: loaded once per participant.
  useEffect(() => {
    if (!participant) return;
    void loadLists(api, participant.id);
  }, [api, participant, loadLists]);

  // A navigation closes the drawer: the link the learner just took is behind it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pathname is the event, not a value read here
  useEffect(() => {
    setDrawer(false);
  }, [location.pathname]);

  const toggleRail = useCallback(() => {
    setRail((current) => {
      const next = !current;
      writeSidebarPreference(platform.storage, next ? 'rail' : 'expanded');
      return next;
    });
  }, [platform.storage]);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader onMenu={() => setDrawer(true)} onToggleSidebar={toggleRail} sidebarRail={rail} />
      <div className="flex w-full flex-1 items-stretch">
        {/* The sidebar is furniture, not page: its own surface says so before any border does. */}
        <aside
          data-testid="sidebar-aside"
          className={cn(
            'sticky top-16 hidden h-[calc(100vh-4rem)] shrink-0 border-r border-outline-variant/70 bg-surface-container-low lg:block',
            rail ? 'w-[72px]' : 'w-[240px]',
          )}
        >
          <Sidebar rail={rail} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <SidebarDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}

/**
 * The standard page inside the shell: a heading, an optional line under it,
 * and the content at a comfortable measure.
 */
export function ShellPage({
  title,
  intro,
  actions,
  children,
}: {
  title: string;
  intro?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 px-6 pt-9 pb-20 sm:px-8">
      <div className="mx-auto w-full max-w-[1100px]">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-headline-small">{title}</h2>
            {intro ? (
              <p className="mt-2 max-w-[620px] text-body-medium text-on-surface-variant">{intro}</p>
            ) : null}
          </div>
          {actions}
        </div>
        {children}
      </div>
    </div>
  );
}
