import type { FeatureSet } from '@pen/contracts';
import { defaultFeaturesFor } from '@pen/contracts';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiClient, type GoogleSignInOutcome, type Participant } from '../api/client.js';
import type { Platform } from '../platform/types.js';
import {
  applyPrivacyChoice,
  identify,
  initAnalytics,
  installMonitor,
  resetAnalytics,
  setAnalyticsPerson,
  trackAction,
} from './analytics.js';
import { bootMode } from './boot.js';
import { forgetGoogleSelection } from './google.js';
import { formatDurationMinutes, formatRelativeDay } from './locale.js';
import { writePacePreference } from './pace-preference.js';
import { type PrivacyChoice, readPrivacy, writePrivacy } from './privacy.js';
import { startVisitTracking } from './visits.js';

interface AppContextValue {
  platform: Platform;
  api: ApiClient;
  participant: Participant | null;
  /**
   * What this learner gets here (ADR-0036): their plan, on this platform, as
   * the server resolved it. Until the server has answered it is the
   * compiled-in rule for the plan we know of, so nothing flickers and nothing
   * that needs a decision waits. The server checks every one of these again.
   */
  features: FeatureSet;
  /** Null while the anonymous participant is being issued; a string when it failed. */
  authError: string | null;
  /** Rename in place; the participant keeps its id and its sessions. */
  setName(name: string): Promise<void>;
  /** The expert who starts every search for this account (ADR-0040); null clears it. */
  setDefaultExpert(expertId: string | null): Promise<void>;
  /** Attach a Google account (the ID token comes from Google's button). */
  signInWithGoogle(idToken: string): Promise<GoogleSignInOutcome>;
  /**
   * The email flows land here too, so a sign-in by any door is the same
   * event: the participant in this context, the analytics identity, the
   * visit's counter. The dialog used to call the client directly for these,
   * which signed the bearer in and left the header saying "Sign in".
   */
  signInWithEmail(email: string, password: string): Promise<void>;
  completeRegistration(body: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
  }): Promise<void>;
  resetPassword(body: { challengeId: string; code: string; password: string }): Promise<void>;
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
  /**
   * The sign-in sheet, from anywhere (ADR-0040): a visitor who likes a card,
   * opens their shelf or asks for a lesson of their own is shown the way in
   * from where they are, not sent to find the header.
   */
  signInOpen: boolean;
  /** Where the sheet was asked for from, for the `sign_in_opened` event the dialog sends. */
  signInSource: string | null;
  openSignIn(source: string): void;
  closeSignIn(): void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  const api = useMemo(
    () => new ApiClient(platform.apiUrl, platform.storage, platform.id),
    [platform],
  );
  // Synchronous and idempotent: the first render can already fail, and the
  // boundary that catches it must have somewhere to send it.
  installMonitor(platform);
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
  const [signIn, setSignIn] = useState<{ open: boolean; source: string | null }>({
    open: false,
    source: null,
  });
  /** Every door in lands here: the account in this context, its pace, its analytics identity. */
  const adoptSignedIn = useCallback(
    (p: Participant, how: { method: 'google' | 'email'; outcome?: string }) => {
      setParticipant(p);
      adoptAccountPace(p);
      identify(p.id);
      setAnalyticsPerson({ anonymous: p.anonymous, plan: p.plan });
      trackAction('signed_in', {
        method: how.method,
        ...(how.outcome ? { outcome: how.outcome } : {}),
      });
    },
    [adoptAccountPace],
  );
  const [served, setServed] = useState<FeatureSet | null>(null);
  const features = useMemo(
    () => served ?? defaultFeaturesFor(participant?.plan ?? 'free', platform.id),
    [served, participant?.plan, platform.id],
  );
  const [authError, setAuthError] = useState<string | null>(null);
  // Read before anything starts: the choice has to apply to the first network
  // call of the visit, not the second.
  const [privacy, setPrivacyState] = useState<PrivacyChoice>(() => readPrivacy(platform.storage));
  /** The tracker reads the choice at send time; turning analytics off stops it at once. */
  const privacyRef = useRef(privacy);
  privacyRef.current = privacy;
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

  /**
   * Engaged time and what this visit did (ADR-0027). One tracker per mount,
   * never on a headless export render, and the bearer is read at send time so
   * a sign-in part-way through moves the visit onto the account. The server
   * drops the beacon outright for anyone who has analytics off, and this
   * stops sending as soon as the choice reaches the client.
   */
  useEffect(() => {
    if (headless) return;
    return startVisitTracking({
      url: `${platform.apiUrl.replace(/\/$/, '')}/api/visits`,
      token: () => platform.storage.get('pen.token'),
      enabled: () => privacyRef.current.analytics,
    });
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
          setAnalyticsPerson({ anonymous: p.anonymous, plan: p.plan });
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

  /**
   * The server's answer follows the participant: a sign-in, a sign-out or a
   * plan change is a new participant object, and each one is a new cell of
   * the matrix. A failed read keeps the compiled-in rule rather than an
   * error, because a flag is never a reason for the page to stop.
   */
  useEffect(() => {
    if (headless || !participant) return;
    let cancelled = false;
    api
      .features()
      .then((f) => {
        if (!cancelled) setServed(f.features);
      })
      .catch(() => {
        if (!cancelled) setServed(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, headless, participant]);

  const value = useMemo<AppContextValue>(
    () => ({
      platform,
      api,
      participant,
      features,
      authError,
      setName: async (name: string) => {
        setParticipant(await api.rename(name));
        trackAction('name_changed');
      },
      setDefaultExpert: async (expertId: string | null) => {
        setParticipant(await api.setDefaultExpert(expertId));
        trackAction('default_expert_set', { expertId: expertId ?? 'none' });
      },
      signInWithGoogle: async (idToken: string) => {
        const { participant: p, outcome } = await api.signInWithGoogle(idToken);
        adoptSignedIn(p, { method: 'google', outcome });
        return outcome;
      },
      signInWithEmail: async (email, password) => {
        adoptSignedIn(await api.signInWithPassword(email, password), { method: 'email' });
      },
      completeRegistration: async (body) => {
        adoptSignedIn(await api.completeRegistration(body), {
          method: 'email',
          outcome: 'created',
        });
      },
      resetPassword: async (body) => {
        adoptSignedIn(await api.resetPassword(body), { method: 'email', outcome: 'reset' });
      },
      privacy,
      setPrivacy: async (choice: PrivacyChoice) => {
        // Said before the switch is thrown: turning analytics off is the last
        // event that goes out, and turning it on is the first.
        if (choice.analytics) applyPrivacyChoice(choice);
        trackAction('analytics_toggled', { on: choice.analytics });
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
        trackAction('account_deleted', { sessions: sessionsDeleted });
        forgetGoogleSelection();
        resetAnalytics();
        const p = await api.ensureParticipant();
        setParticipant(p);
        identify(p.id);
        setAnalyticsPerson({ anonymous: p.anonymous, plan: p.plan });
        return sessionsDeleted;
      },
      signInOpen: signIn.open,
      signInSource: signIn.source,
      openSignIn: (source: string) => setSignIn({ open: true, source }),
      closeSignIn: () => setSignIn({ open: false, source: null }),
      signOut: async () => {
        trackAction('signed_out');
        api.signOut();
        forgetGoogleSelection();
        resetAnalytics();
        const p = await api.ensureParticipant();
        setParticipant(p);
        identify(p.id);
        setAnalyticsPerson({ anonymous: p.anonymous, plan: p.plan });
      },
    }),
    [platform, api, participant, features, authError, privacy, adoptSignedIn, signIn],
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
