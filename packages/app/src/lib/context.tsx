import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { ApiClient, type GoogleSignInOutcome, type Participant } from '../api/client.js';
import type { Platform } from '../platform/types.js';
import { identify, initAnalytics, resetAnalytics, track } from './analytics.js';
import { bootMode } from './boot.js';
import { forgetGoogleSelection } from './google.js';

interface AppContextValue {
  platform: Platform;
  api: ApiClient;
  participant: Participant | null;
  /** Null while the anonymous participant is being issued; a string when it failed. */
  authError: string | null;
  /** Rename in place; the participant keeps its id and its sessions. */
  setName(name: string): Promise<void>;
  /** Attach a Google account (the ID token comes from Google's button). */
  signInWithGoogle(idToken: string): Promise<GoogleSignInOutcome>;
  /** Back to a fresh anonymous participant. */
  signOut(): Promise<void>;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  const api = useMemo(() => new ApiClient(platform.apiUrl, platform.storage), [platform]);
  const [participant, setParticipant] = useState<Participant | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // A headless export render is a pure player: no identity, no analytics (see lib/boot.ts).
  const headless = useMemo(
    () => typeof window !== 'undefined' && bootMode(window.location) === 'headless-render',
    [],
  );

  useEffect(() => {
    if (!headless) initAnalytics(platform);
  }, [platform, headless]);

  useEffect(() => {
    if (headless) return;
    let cancelled = false;
    api
      .ensureParticipant()
      .then((p) => {
        if (!cancelled) {
          setParticipant(p);
          identify(p.id);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setAuthError(error instanceof Error ? error.message : 'Could not reach Pen Playground.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, headless]);

  const value = useMemo<AppContextValue>(
    () => ({
      platform,
      api,
      participant,
      authError,
      setName: async (name: string) => {
        setParticipant(await api.rename(name));
      },
      signInWithGoogle: async (idToken: string) => {
        const { participant: p, outcome } = await api.signInWithGoogle(idToken);
        setParticipant(p);
        identify(p.id);
        track('sign_in', { provider: 'google', outcome });
        return outcome;
      },
      signOut: async () => {
        api.signOut();
        forgetGoogleSelection();
        resetAnalytics();
        track('sign_out');
        const p = await api.ensureParticipant();
        setParticipant(p);
        identify(p.id);
      },
    }),
    [platform, api, participant, authError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return `${min} min`;
}

export function relativeDay(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 14) return 'Last week';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
