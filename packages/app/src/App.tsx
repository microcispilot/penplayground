import { ToastProvider } from '@pen/design';
import { useEffect } from 'react';
import { BrowserRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { AppShell } from './components/AppShell.js';
import { setAnalyticsContext, trackInteraction } from './lib/analytics.js';
import { AppProvider } from './lib/context.js';
import type { Platform } from './platform/types.js';
import { Experts } from './screens/Experts.js';
import { Home } from './screens/Home.js';
import { Library } from './screens/Library.js';
import {
  DownloadsScreen,
  HistoryScreen,
  LikedScreen,
  RoomsScreen,
  SavedScreen,
} from './screens/Lists.js';
import { Privacy } from './screens/legal/Privacy.js';
import { Terms } from './screens/legal/Terms.js';
import { NotFound } from './screens/NotFound.js';
import { Pricing } from './screens/Pricing.js';
import { Replay } from './screens/Replay.js';
import { Room } from './screens/Room.js';
import { SessionPage } from './screens/SessionPage.js';

/** Which screen is on: a route pattern, never the id in it (ids are not content, but screens are what we chart). */
function screenOf(pathname: string): string {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/room/')) return 'room';
  if (pathname.startsWith('/replay/')) return 'replay';
  if (pathname.startsWith('/sessions/')) return 'session';
  if (pathname === '/sessions') return 'library';
  if (pathname === '/pricing') return 'pricing';
  if (pathname === '/experts') return 'experts';
  if (pathname === '/history') return 'history';
  if (pathname === '/saved') return 'saved';
  if (pathname === '/liked') return 'liked';
  if (pathname === '/downloads') return 'downloads';
  if (pathname === '/rooms') return 'rooms';
  if (pathname === '/terms') return 'terms';
  if (pathname === '/privacy') return 'privacy';
  return 'not-found';
}

/** Every screen transition is a "shown" event (and a Sentry breadcrumb). */
function ScreenTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    const screen = screenOf(pathname);
    setAnalyticsContext({ screen });
    trackInteraction('screen_shown', { screen });
  }, [pathname]);
  return null;
}

/** A new screen starts at the top; the room and the replay never scroll. */
function ScrollToTop() {
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the new pathname is the event this reacts to
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

/** Everything but the room and the replay lives in the shell (ADR-0015). */
function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/** The whole product. Hosts render this once with their Platform. */
export function PenApp({ platform }: { platform: Platform }) {
  return (
    <AppProvider platform={platform}>
      <ToastProvider>
        <BrowserRouter>
          <ScreenTracker />
          <ScrollToTop />
          <Routes>
            <Route element={<ShellLayout />}>
              <Route path="/" element={<Home />} />
              <Route path="/experts" element={<Experts />} />
              <Route path="/sessions" element={<Library />} />
              <Route path="/sessions/:id" element={<SessionPage />} />
              <Route path="/history" element={<HistoryScreen />} />
              <Route path="/saved" element={<SavedScreen />} />
              <Route path="/liked" element={<LikedScreen />} />
              <Route path="/downloads" element={<DownloadsScreen />} />
              <Route path="/rooms" element={<RoomsScreen />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="*" element={<NotFound />} />
            </Route>
            {/* The board is the whole screen here: no shell, no sidebar. */}
            <Route path="/room/:id" element={<Room />} />
            <Route path="/replay/:id" element={<Replay />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AppProvider>
  );
}
