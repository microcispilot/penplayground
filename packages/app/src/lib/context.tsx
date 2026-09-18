import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiClient, type GoogleSignInOutcome, type Participant } from '../api/client.js';
import type { Platform } from '../platform/types.js';
import { applyPrivacyChoice, identify, initAnalytics, resetAnalytics, track } from './analytics.js';
import { bootMode } from './boot.js';
import { forgetGoogleSelection } from './google.js';
import { formatDurationMinutes, formatRelativeDay } from './locale.js';
import { writePacePreference } from './pace-preference.js';
import { type PrivacyChoice, readPrivacy, writePrivacy } from './privacy.js';

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
  /**
   * The learner's privacy choice. There is no banner to answer (ADR-0018):
   * this is the quiet switch behind "Privacy choices".
   */
  privacy: PrivacyChoice;
  setPrivacy(choice: PrivacyChoice): Promise<void>;
  /** Erase the account, its sessions and everything they recorded. */
  deleteAccount(): Promise<number>;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  const api = useMemo(() => new ApiClient(platform.apiUrl, platform.storage), [platform]);
  /**
   * A signed-in learner's pace belongs to them, not to the browser they are
   * in: the account's value replaces whatever this device remembered, so the
   * room opens at their pace on a machine they have never used (ADR-0010).
   * An anonymous participant has no account to speak for them and keeps the
   * device's own preference untouched.
   */
  const adoptAccountPace = useCallback(
    (p: Participant) => {
      if (!p.anonymous) writePacePreference(platform.storage, p.pace);
    },
    [platform.storage],
  );
  const [participant, setParticipant] = useState<Participant | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Read before anything starts: the choice has to apply to the first network
  // call of the visit, not the second.
  const [privacy, setPrivacyState] = useState<PrivacyChoice>(() => readPrivacy(platform.storage));
  // A headless export render is a pure player: no identity, no analytics (see lib/boot.ts).
  const headless = useMemo(
    () =>
      typeof window !== 'undefined' &&
      bootMode(window.location, platform.basePath) === 'headless-render',
    [platform.basePath],
  );

  // Deliberately once per mount: PostHog is initialised with the choice that was
  // in force when the page opened, and a later change is applied through
  // `applyPrivacyChoice` rather than by re-initialising the SDK.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!headless) initAnalytics(platform, privacy);
  }, [platform, headless]);

  useEffect(() => {
    if (headless) return;
    let cancelled = false;
    api
      .ensureParticipant()
      .then((p) => {
        if (!cancelled) {
          setParticipant(p);
          adoptAccountPace(p);
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
  }, [api, headless, adoptAccountPace]);

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
        adoptAccountPace(p);
        identify(p.id);
        track('sign_in', { provider: 'google', outcome });
        return outcome;
      },
      privacy,
      setPrivacy: async (choice: PrivacyChoice) => {
        writePrivacy(platform.storage, choice);
        setPrivacyState(choice);
        applyPrivacyChoice(choice);
        // The server keeps its own copy, so its capture honours the same switch.
        try {
          await api.setAnalyticsOptOut(!choice.analytics);
        } catch {
          // The device's choice already stands; the row catches up next time.
        }
      },
      deleteAccount: async () => {
        const sessionsDeleted = await api.deleteAccount();
        forgetGoogleSelection();
        resetAnalytics();
        setParticipant(await api.ensureParticipant());
        return sessionsDeleted;
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
    [platform, api, participant, authError, privacy, adoptAccountPace],
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

/**
 * Durations and dates are the reader's, not the product's: `Intl` writes them
 * in the browser's own language and numbering system (lib/locale.ts).
 */
export const formatDuration = formatDurationMinutes;
export const relativeDay = formatRelativeDay;
