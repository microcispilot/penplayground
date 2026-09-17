import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { ApiClient, type Participant } from '../api/client.js';
import type { Platform } from '../platform/types.js';
import { identify, initAnalytics } from './analytics.js';

interface AppContextValue {
  platform: Platform;
  api: ApiClient;
  participant: Participant | null;
  /** Null while the anonymous participant is being issued; a string when it failed. */
  authError: string | null;
  setName(name: string): Promise<void>;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  const api = useMemo(() => new ApiClient(platform.apiUrl, platform.storage), [platform]);
  const [participant, setParticipant] = useState<Participant | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => initAnalytics(platform), [platform]);

  useEffect(() => {
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
  }, [api]);

  const value = useMemo<AppContextValue>(
    () => ({
      platform,
      api,
      participant,
      authError,
      setName: async (name: string) => {
        platform.storage.remove('pen.token');
        const p = await new ApiClient(platform.apiUrl, platform.storage).ensureParticipant(name);
        setParticipant(p);
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
