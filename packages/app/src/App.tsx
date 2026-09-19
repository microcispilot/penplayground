import { Skeleton, ToastProvider } from '@pen/design';
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { AppShell } from './components/AppShell.js';
import { preloadBoard } from './components/BoardSurface.js';
import { setAnalyticsContext, trackInteraction } from './lib/analytics.js';
import { routerBasename, withBasePath } from './lib/base-path.js';
import { AppProvider } from './lib/context.js';
import { RouteHead, setSeoBasePath } from './lib/seo.js';
import { noteScreen } from './lib/visits.js';
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
import { NotFound } from './screens/NotFound.js';
import { Pricing } from './screens/Pricing.js';

/*
 * Route-level splitting. Home is the screen every visit starts on, so it — and
 * the light list screens that sit one click from it — stay in the entry: a
 * chunk request there would only add a round trip to a screen that is already
 * cheap. What leaves the entry is what is heavy and reached by a decision:
 *
 *   - the room and the replay drive the board, the audio clock and the
 *     conductor, and are entered from a card or a link, never on first paint;
 *   - the session page carries Insights (the whole telemetry read-out: ledger
 *     parsing, the cost/stage breakdown) plus the export flow;
 *   - the legal pages are long static prose nobody reads on the way in.
 *
 * The room and the replay both paint the board, and its chunk (tldraw + the ink
 * engine) is far larger than the route's. Kicking `preloadBoard()` as the route
 * chunk is requested puts the two downloads in flight together instead of one
 * after the other — the screen's own `preloadBoard()` effect stays, for a
 * warm chunk on a re-entry.
 */
const Room = lazy(async () => {
  preloadBoard();
  return { default: (await import('./screens/Room.js')).Room };
});
const Replay = lazy(async () => {
  preloadBoard();
  return { default: (await import('./screens/Replay.js')).Replay };
});
const SessionPage = lazy(async () => ({
  default: (await import('./screens/SessionPage.js')).SessionPage,
}));
const Terms = lazy(async () => ({ default: (await import('./screens/legal/Terms.js')).Terms }));
const Privacy = lazy(async () => ({
  default: (await import('./screens/legal/Privacy.js')).Privacy,
}));

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
    // The same transition, to the visit's own engaged-time ledger (ADR-0027).
    noteScreen(screen);
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

/**
 * What a split screen shows while its chunk is in flight. The header and the
 * sidebar are already painted around it, so this is only the panel: the shape
 * of the page in `bg-surface-container-high`, at the same measure `ShellPage` uses. No
 * spinner, and nothing that flashes — on a warm cache the chunk is there
 * within a frame and this is never seen at all.
 */
function ShellFallback() {
  return (
    <div className="flex-1 px-6 pt-9 pb-20 sm:px-8" data-testid="route-loading">
      <div className="mx-auto w-full max-w-[1100px]">
        <Skeleton className="h-9 w-[min(18rem,60%)]" />
        <Skeleton className="mt-3 h-4 w-[min(32rem,85%)]" />
        <Skeleton className="mt-9 h-[42vh] min-h-[220px] w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * The room and the replay are the whole viewport, and they open on a dark
 * board rather than a document: the calm thing to hold is that surface, not a
 * page skeleton sized for the shell.
 */
function BoardFallback() {
  return <div className="h-dvh w-full bg-surface" data-testid="route-loading" aria-hidden />;
}

/** Everything but the room and the replay lives in the shell (ADR-0015). */
function ShellLayout() {
  return (
    <AppShell>
      <Suspense fallback={<ShellFallback />}>
        <Outlet />
      </Suspense>
    </AppShell>
  );
}

/**
 * The whole product. Hosts render this once with their Platform.
 *
 * `platform.basePath` is where the app is mounted on its origin. It reaches
 * three places from here and nowhere else: react-router's `basename` (which
 * puts the prefix on every `<Link>`, `navigate()` and `useLocation()`, so no
 * screen ever spells it), the canonical URLs in `lib/seo.ts`, and the one full
 * page load the router does not own — "Back to Explore" on the crash screen.
 */
export function PenApp({ platform }: { platform: Platform }) {
  // Before the first effect runs: a canonical URL must never be written without the prefix.
  setSeoBasePath(platform.basePath);
  return (
    // Outermost: a crash inside a provider still lands on a screen, not a white page.
    <AppErrorBoundary homeHref={withBasePath(platform.basePath, '/')}>
      <AppProvider platform={platform}>
        <ToastProvider>
          <BrowserRouter basename={routerBasename(platform.basePath)}>
            <ScreenTracker />
            <ScrollToTop />
            <RouteHead />
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
              <Route
                path="/room/:id"
                element={
                  <Suspense fallback={<BoardFallback />}>
                    <Room />
                  </Suspense>
                }
              />
              <Route
                path="/replay/:id"
                element={
                  <Suspense fallback={<BoardFallback />}>
                    <Replay />
                  </Suspense>
                }
              />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AppProvider>
    </AppErrorBoundary>
  );
}
