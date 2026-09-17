import type { Expert, RoomState } from '@pen/contracts';
import { Button, ExpertOrb, IconButton, Pill } from '@pen/design';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { BoardSurface } from '../components/BoardSurface.js';
import { describeReplayRate, PaceMenu } from '../components/PaceMenu.js';
import { CaptionOverlay } from '../components/RoomChrome.js';
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

  useEffect(() => {
    if (!started || exportMode) return;
    const t = setInterval(() => {
      if (!paused) {
        // The clock counts recorded time: at 2× it advances twice as fast, like a video's scrubber.
        clockRef.current += 250 * rate;
        useRoomStore.getState().set({ clockMs: clockRef.current });
      }
    }, 250);
    return () => clearInterval(t);
  }, [started, paused, exportMode, rate]);

  const changeRate = (next: number) => {
    setRate(next);
    writePacePreference(platform.storage, next, REPLAY_RATE_PREFERENCE_KEY);
    session?.setPlaybackRate(next);
  };

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center px-7">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-md">{error}</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
        </div>
      </div>
    );
  }

  const presence = !started ? 'idle' : paused ? 'paused' : ui.speaking ? 'speaking' : 'idle';
  const stage = (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-[6px] shadow-board">
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
      {!started && !exportMode ? (
        <div className="absolute inset-0 z-[9] grid place-items-center bg-navy-900/60">
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
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg [&>div]:rounded-none [&>div]:shadow-none">
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <div className="flex min-h-0 flex-1 p-4">{stage}</div>
      <div className="flex h-[54px] shrink-0 items-center gap-3 border-t border-line bg-surface px-3.5">
        <IconButton label="Back" onClick={() => navigate(`/sessions/${id}`)}>
          <ArrowLeft size={15} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <Pill tone="accent">Replay</Pill>
        <span className="text-sm text-fg-2 tabular">{formatClock(ui.clockMs)}</span>
        <PaceMenu value={rate} onChange={changeRate} label="Speed" describe={describeReplayRate} />
        <IconButton
          label={paused ? 'Resume' : 'Pause'}
          onClick={() => {
            if (!session) return;
            if (paused) session.resume();
            else session.pause();
            trackInteraction(paused ? 'resume' : 'pause', { replay: true });
            setPaused(!paused);
          }}
          disabled={!started}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </IconButton>
      </div>
    </div>
  );
}
