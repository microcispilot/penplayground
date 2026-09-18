import { ToastProvider } from '@pen/design';
import { useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { setAnalyticsContext, trackInteraction } from './lib/analytics.js';
import { AppProvider } from './lib/context.js';
import { RouteHead } from './lib/seo.js';
import type { Platform } from './platform/types.js';
import { Home } from './screens/Home.js';
import { Library } from './screens/Library.js';
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

/** The whole product. Hosts render this once with their Platform. */
export function PenApp({ platform }: { platform: Platform }) {
  return (
    // Outermost: a crash inside a provider still lands on a screen, not a white page.
    <AppErrorBoundary>
      <AppProvider platform={platform}>
        <ToastProvider>
          <BrowserRouter>
            <ScreenTracker />
            <RouteHead />
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/sessions" element={<Library />} />
              <Route path="/sessions/:id" element={<SessionPage />} />
              <Route path="/room/:id" element={<Room />} />
              <Route path="/replay/:id" element={<Replay />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AppProvider>
    </AppErrorBoundary>
  );
}
