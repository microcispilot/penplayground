import type { Expert, RoomState } from '@pen/contracts';
import { Button, ExpertOrb, IconButton, Pill } from '@pen/design';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { BoardSurface } from '../components/BoardSurface.js';
import { CaptionOverlay } from '../components/RoomChrome.js';
import { formatClock, useApp } from '../lib/context.js';
import { ReplaySession } from '../room/ReplaySession.js';
import { useRoomStore } from '../room/store.js';

/**
 * Watch a saved session exactly as it was taught: same conductor, same board
 * pacing, same captions. Starts on a click so audio is allowed to play.
 */
export function Replay() {
  const { id = '' } = useParams();
  const { api, platform } = useApp();
  const navigate = useNavigate();
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [expert, setExpert] = useState<Expert | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const clockRef = useRef(0);
  const ui = useRoomStore();

  useEffect(() => {
    const s = new ReplaySession(api, id);
    setSession(s);
    Promise.all([s.load(), api.getSession(id)])
      .then(([st, meta]) => {
        setState(st);
        setExpert(meta.expert);
        setTitle(meta.session.title);
        useRoomStore.getState().set({ expert: meta.expert });
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not load the session.'),
      );
    return () => {
      s.dispose();
      setSession(null);
    };
  }, [api, id]);

  const begin = async () => {
    if (!session || !state) return;
    const set = useRoomStore.getState().set;
    setStarted(true);
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
    if (!started) return;
    const t = setInterval(() => {
      if (!paused) {
        clockRef.current += 250;
        useRoomStore.getState().set({ clockMs: clockRef.current });
      }
    }, 250);
    return () => clearInterval(t);
  }, [started, paused]);

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
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <div className="flex min-h-0 flex-1 p-4">
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
          {!started ? (
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
      </div>
      <div className="flex h-[54px] shrink-0 items-center gap-3 border-t border-line bg-surface px-3.5">
        <IconButton label="Back" onClick={() => navigate(`/sessions/${id}`)}>
          <ArrowLeft size={15} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <Pill tone="accent">Replay</Pill>
        <span className="text-sm text-fg-2 tabular">{formatClock(ui.clockMs)}</span>
        <IconButton
          label={paused ? 'Resume' : 'Pause'}
          onClick={() => {
            if (!session) return;
            if (paused) session.resume();
            else session.pause();
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
