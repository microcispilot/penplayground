import type { Expert, RoomState } from '@pen/contracts';
import { Button, ExpertOrb, IconButton, Pill } from '@pen/design';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { BoardSurface } from '../components/BoardSurface.js';
import { describeReplayRate, PaceMenu } from '../components/PaceMenu.js';
import { ARROW_STEP_MS, JL_STEP_MS, ReplayScrubber } from '../components/ReplayScrubber.js';
import { CaptionOverlay, ReplayNotice } from '../components/RoomChrome.js';
import { setAnalyticsContext, trackInteraction } from '../lib/analytics.js';
import { formatClock, useApp } from '../lib/context.js';
import {
  REPLAY_RATE_PREFERENCE_KEY,
  readPacePreference,
  writePacePreference,
} from '../lib/pace-preference.js';
import { ReplaySession } from '../room/ReplaySession.js';
import { useRoomStore } from '../room/store.js';

/**
 * Installed by the export renderer (services/api export/render.ts) before the
 * page loads. Every time is `performance.now()` relative to the frame that
 * lifted the sync curtain, i.e. t=0 of the video.
 */
interface PenExportBridge {
  onSayStart(sayId: string, take: number, videoTimeMs: number, index: number, total: number): void;
  onDone(doneMs: number): void;
  onError(message: string): void;
}
declare global {
  interface Window {
    __penExport?: PenExportBridge;
  }
}

/**
 * Watch a saved session exactly as it was taught: same conductor, same board
 * pacing, same captions. Starts on a click so audio is allowed to play.
 *
 * `?export=1` is the headless render mode: no click, no chrome, no Web Audio.
 * The page stays a solid black curtain until the board is mounted and fonts
 * are ready, then lifts the curtain and starts the export clock in the same
 * animation frame; it drops the curtain again when the last sentence (+1 s)
 * has played. The renderer finds both edges on the recording and aligns the
 * audio to the say offsets reported from here.
 */
export function Replay() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const exportMode = params.get('export') === '1';
  const { api, platform } = useApp();
  const navigate = useNavigate();
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [expert, setExpert] = useState<Expert | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  // The viewer's speed is a habit: remembered per device, never applied to an export render.
  const [rate, setRate] = useState(() =>
    exportMode ? 1 : (readPacePreference(platform.storage, REPLAY_RATE_PREFERENCE_KEY) ?? 1),
  );
  const clockRef = useRef(0);
  const [position, setPosition] = useState(0);
  const [buffered, setBuffered] = useState(0);
  /** While a drag is in flight the handle follows the pointer, not the player. */
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const curtainRef = useRef<HTMLDivElement>(null);
  /** The session instance the export was started for (StrictMode re-runs effects; sessions are per mount). */
  const exportStartedFor = useRef<ReplaySession | null>(null);
  const beginRef = useRef<() => Promise<void>>(async () => undefined);
  /** The rate a freshly created session starts with (the effect above must not re-run on rate changes). */
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const ui = useRoomStore();

  useEffect(() => {
    const s = new ReplaySession(api, id, { mode: exportMode ? 'export' : 'play' });
    if (!exportMode) s.setPlaybackRate(rateRef.current);
    setSession(s);
    Promise.all([s.load(), api.getSession(id)])
      .then(([st, meta]) => {
        if (s.isDisposed) return; // StrictMode: the first mount's session is gone
        setState(st);
        setExpert(meta.expert);
        setTitle(meta.session.title);
        useRoomStore.getState().set({ expert: meta.expert });
      })
      .catch((e: unknown) => {
        if (s.isDisposed) return;
        setError(e instanceof Error ? e.message : 'Could not load the session.');
      });
    return () => {
      s.dispose();
      setSession(null);
    };
  }, [api, id, exportMode]);

  const begin = async () => {
    if (!session || !state) return;
    const set = useRoomStore.getState().set;
    setStarted(true);
    if (!exportMode) {
      setAnalyticsContext({ sessionId: id, role: null, phase: 'replay' });
      trackInteraction('replay_started', { cues: state.plan?.segments.length ?? 0 });
    }
    await session.start(state, {
      captions: {
        showExpert: (text, revealMs) =>
          set({
            caption: {
              who: 'expert',
              speaker: expert?.displayName.split(' ')[0] ?? 'Expert',
              text,
              revealMs,
              live: false,
              at: Date.now(),
            },
          }),
        showLearner: (name, text, final) =>
          set({
            caption: {
              who: 'learner',
              speaker: name,
              text,
              revealMs: 0,
              live: !final,
              at: Date.now(),
            },
          }),
        hint: (text) => set({ hint: text }),
        clear: () => set({ caption: null }),
      },
      presence: {
        setState: (st) => set({ state: st }),
        setSpeaking: (speaking) => set({ speaking }),
        showCheck: (check) => set({ check }),
        showAd: () => undefined,
        setWaiting: (waiting) => set({ waiting }),
        notice: (text, tone) => set({ notice: text ? { text, tone } : null }),
      },
    });
  };

  useEffect(() => {
    beginRef.current = begin;
  });

  // Export mode: the render starts itself once everything that can affect a frame is in place.
  useEffect(() => {
    if (!exportMode || !session || !state || exportStartedFor.current === session) return;
    exportStartedFor.current = session;
    // No cleanup cancellation: a disposed session (unmount) simply ignores the clock.
    const run = async () => {
      await beginRef.current();
      await Promise.race([
        session.boardReady,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('board did not mount within 30 s')), 30_000),
        ),
      ]);
      await document.fonts.ready.catch(() => undefined);
      // Two frames so the mounted board has painted at least once behind the curtain.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (session.isDisposed) return;
      requestAnimationFrame(() => {
        if (session.isDisposed) return;
        const curtain = curtainRef.current;
        if (curtain) curtain.hidden = true;
        const videoStart = performance.now();
        session.beginExport({
          onSayStart: (sayId, take, index, total) =>
            window.__penExport?.onSayStart(
              sayId,
              take,
              performance.now() - videoStart,
              index,
              total,
            ),
          onDone: () =>
            requestAnimationFrame(() => {
              if (curtain) curtain.hidden = false;
              window.__penExport?.onDone(performance.now() - videoStart);
            }),
        });
      });
    };
    run().catch((e: unknown) =>
      window.__penExport?.onError(e instanceof Error ? e.message : String(e)),
    );
  }, [exportMode, session, state]);

  useEffect(() => {
    if (exportMode && error) window.__penExport?.onError(error);
  }, [exportMode, error]);

  // The scrubber reads the recording's own clock (the audio clock is master,
  // ADR-0002) rather than counting wall time, so a seek is reflected immediately
  // and a stretched playback rate cannot make the two disagree.
  useEffect(() => {
    if (!started || exportMode || !session) return;
    const tick = () => {
      clockRef.current = session.positionMs;
      useRoomStore.getState().set({ clockMs: clockRef.current });
      setPosition(session.positionMs);
      setBuffered(session.bufferedMs);
    };
    tick();
    const t = setInterval(tick, 200);
    return () => clearInterval(t);
  }, [started, exportMode, session]);

  const changeRate = (next: number) => {
    setRate(next);
    writePacePreference(platform.storage, next, REPLAY_RATE_PREFERENCE_KEY);
    session?.setPlaybackRate(next);
  };

  const togglePlay = useCallback(() => {
    if (!session || !started) return;
    if (paused) session.resume();
    else session.pause();
    trackInteraction(paused ? 'resume' : 'pause', { replay: true });
    setPaused(!paused);
  }, [session, started, paused]);

  const seekTo = useCallback(
    (toMs: number) => {
      if (!session || !started) return;
      const total = session.timeline.totalMs;
      const to = Math.max(0, Math.min(total, Math.round(toMs)));
      const from = Math.round(session.positionMs);
      setScrubbing(null);
      setPosition(to);
      // Reserved in the telemetry contract for exactly this (ADR-0011): where the
      // viewer was and where they went, in ms — a number, never a sentence.
      trackInteraction('replay_seeked', { fromMs: from, toMs: to });
      void session.seek(to);
    },
    [session, started],
  );

  // The shortcuts a video player has taught everyone. Skipped while the viewer is
  // typing, and while the headless renderer is driving the page.
  useEffect(() => {
    if (exportMode || !started) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const at = session?.positionMs ?? 0;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          return;
        case 'ArrowRight':
          e.preventDefault();
          seekTo(at + ARROW_STEP_MS);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          seekTo(at - ARROW_STEP_MS);
          return;
        case 'l':
        case 'L':
          e.preventDefault();
          seekTo(at + JL_STEP_MS);
          return;
        case 'j':
        case 'J':
          e.preventDefault();
          seekTo(at - JL_STEP_MS);
          return;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportMode, started, session, seekTo, togglePlay]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center px-7">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-body-large">{error}</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
        </div>
      </div>
    );
  }

  const presence = !started ? 'idle' : paused ? 'paused' : ui.speaking ? 'speaking' : 'idle';
  const stage = (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm shadow-board">
      <BoardSurface session={session} licenseKey={platform.tldrawLicenseKey} />
      <div className="absolute right-3 bottom-3 z-[6]">
        <ExpertOrb
          name={expert?.displayName ?? 'Expert'}
          portraitUrl={api.portraitUrl(expert?.portrait?.src)}
          presence={presence}
          size={88}
        />
      </div>
      <CaptionOverlay line={ui.caption} hint={ui.hint} on={ui.captionsOn} />
      {exportMode ? null : <ReplayNotice notice={ui.notice} />}
      {!started && !exportMode ? (
        <div className="absolute inset-0 z-[9] grid place-items-center bg-scrim/60">
          <Button
            variant="primary"
            size="lg"
            leading={<Play size={16} />}
            onClick={() => void begin()}
            disabled={!state}
          >
            Play the session
          </Button>
        </div>
      ) : null}
    </div>
  );

  if (exportMode) {
    // Only the board, captions and orb reach the recording; the curtain is the sync marker.
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface [&>div]:rounded-none [&>div]:shadow-none">
        {stage}
        <div
          ref={curtainRef}
          data-testid="export-curtain"
          aria-hidden
          className="fixed inset-0 z-[1000]"
          style={{ background: '#000' }}
        />
      </div>
    );
  }

  const timeline = session?.timeline ?? null;
  const totalMs = timeline?.totalMs ?? 0;
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface">
      <div className="flex min-h-0 flex-1 p-2 sm:p-3 lg:p-4">{stage}</div>
      <div className="shrink-0 border-t border-outline-variant bg-surface-container-low px-3 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] sm:px-3.5">
        <ReplayScrubber
          positionMs={scrubbing ?? position}
          totalMs={totalMs}
          bufferedMs={buffered}
          chapters={timeline?.chapters ?? []}
          disabled={!started || totalMs <= 0}
          onScrub={setScrubbing}
          onSeek={seekTo}
          className="mb-1"
        />
        <div className="flex items-center gap-2 sm:gap-3">
          <IconButton label="Back" onClick={() => navigate(`/sessions/${id}`)}>
            <ArrowLeft size={15} />
          </IconButton>
          <IconButton
            label={paused ? 'Play' : 'Pause'}
            onClick={togglePlay}
            disabled={!started}
            data-testid="replay-play"
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </IconButton>
          <span
            className="shrink-0 text-body-medium text-on-surface-variant tabular"
            data-testid="replay-clock"
          >
            {formatClock(scrubbing ?? position)} / {formatClock(totalMs)}
          </span>
          <span className="hidden min-w-0 flex-1 truncate text-body-medium sm:block">{title}</span>
          <span className="flex-1 sm:hidden" />
          <Pill tone="accent" className="hidden sm:inline-flex">
            Replay
          </Pill>
          <PaceMenu
            value={rate}
            onChange={changeRate}
            label="Speed"
            describe={describeReplayRate}
          />
        </div>
      </div>
    </div>
  );
}
