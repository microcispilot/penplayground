import type { Expert } from '@pen/contracts';
import { Button, ExpertOrb, Pill, useToast } from '@pen/design';
import { Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { BoardSurface, preloadBoard } from '../components/BoardSurface.js';
import {
  AskSheet,
  BottomBar,
  CaptionOverlay,
  CheckCard,
  PreparingView,
  RecapPanel,
  RoomStatus,
} from '../components/RoomChrome.js';
import { VideoAd } from '../components/VideoAd.js';
import { trackInteraction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { RoomSession } from '../room/RoomSession.js';
import { useRoomStore } from '../room/store.js';

/** The orb is presence, not a portrait: it gives the board back its room on a small screen. */
function orbSizeFor(width: number): number {
  if (width < 640) return 52;
  if (width < 1024) return 68;
  return 88;
}

function useOrbSize(): number {
  const [size, setSize] = useState(() =>
    orbSizeFor(typeof window === 'undefined' ? 1280 : window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setSize(orbSizeFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/**
 * The live classroom. One RoomSession owns the socket, audio, mic and
 * conductor; this component renders the store and forwards intents.
 */
export function Room() {
  const { id = '' } = useParams();
  const { api, platform, participant } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [expert, setExpert] = useState<Expert | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [typed, setTyped] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  const ui = useRoomStore();
  const orbSize = useOrbSize();

  // The board chunk is lazy (it carries tldraw); fetch it while the room is still
  // preparing so the paper is mounted before the first cue, not downloading on it.
  useEffect(() => {
    preloadBoard();
  }, []);

  // Expert + session record for the chrome.
  useEffect(() => {
    let cancelled = false;
    api
      .getSession(id)
      .then(({ expert: e }) => {
        if (!cancelled) {
          setExpert(e);
          useRoomStore.getState().set({ expert: e });
        }
      })
      .catch(() => {
        if (!cancelled) useRoomStore.getState().set({ errorText: 'This session does not exist.' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  // Start the session once we have a participant. Audio needs a user gesture: if we arrived
  // from a click (Start session) the context unlocks silently; otherwise we show one button.
  useEffect(() => {
    if (!participant) return;
    const s = new RoomSession({
      api,
      platform,
      sessionId: id,
      participantId: participant.id,
      displayName: participant.name,
    });
    setSession(s);
    // The mic preference is remembered per device; first visit defaults to on.
    const autoMic = platform.storage.get('pen.mic') !== 'off';
    s.start()
      .then(() => (autoMic ? s.enableMic() : undefined))
      .catch(() => setNeedsGesture(true));
    return () => {
      s.dispose();
      setSession(null);
    };
  }, [api, platform, id, participant]);

  const isHost = ui.state?.hostId === participant?.id;
  const firstName = expert?.displayName.split(' ')[0] ?? 'Expert';
  const portrait = api.portraitUrl(expert?.portrait?.src, 192);
  const presence =
    ui.state?.phase !== 'live'
      ? 'idle'
      : ui.state.mode === 'listening'
        ? 'listening'
        : ui.state.mode === 'thinking'
          ? 'thinking'
          : ui.state.mode === 'paused'
            ? 'paused'
            : ui.speaking
              ? 'speaking'
              : 'idle';
  const checkQuestion = useMemo(
    () => (ui.caption?.who === 'expert' ? ui.caption.text : ''),
    [ui.caption],
  );
  const questions = useMemo(
    () => ui.notes.map((n) => ({ q: n.question, a: `${n.headline} — ${n.detail}` })),
    [ui.notes],
  );

  /**
   * One control for "I cannot hear anything". Either the browser is holding the
   * audio context (the usual case) or `start()` never got its gesture at all,
   * and the learner should not have to know the difference.
   */
  const enableSound = () => {
    if (needsGesture) {
      setNeedsGesture(false);
      session
        ?.start()
        .then(() => session.enableMic())
        .catch(() => toast('Audio could not start', 'danger'));
      return;
    }
    void session?.enableSound();
  };

  const toggleMic = () => {
    if (ui.micState === 'listening') {
      session?.disableMic();
      platform.storage.set('pen.mic', 'off');
    } else {
      platform.storage.set('pen.mic', 'on');
      void session?.enableMic();
    }
  };

  if (ui.errorText) {
    return (
      <div className="grid min-h-screen place-items-center px-7">
        <div className="flex max-w-[420px] flex-col items-center gap-4 text-center">
          <p className="text-md text-fg">{ui.errorText}</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
        </div>
      </div>
    );
  }

  if (!ui.state || ui.state.phase === 'preparing') {
    return (
      <div className="relative">
        {ui.ad && session ? (
          <VideoAd
            ad={ui.ad}
            {...(ui.state?.language ? { locale: ui.state.language } : {})}
            onEvent={(name, props) => session.adEvent(name, props)}
            onEnd={(reason) => session.skipAd(reason)}
          />
        ) : null}
        <PreparingView
          expertName={expert?.displayName ?? '…'}
          expertRole={expert?.role ?? ''}
          portraitUrl={portrait}
          topic={ui.state?.topic ?? ''}
          plan={ui.state?.plan ?? null}
          progress={
            ui.preparation
              ? { fraction: ui.preparation.fraction, status: ui.preparation.status }
              : ui.connection === 'open'
                ? { fraction: 0.05, status: 'Finding the right material…' }
                : { fraction: 0.02, status: 'Connecting…' }
          }
        />
      </div>
    );
  }

  const state = ui.state;
  return (
    <div ref={shellRef} className="flex h-dvh flex-col overflow-hidden bg-bg">
      {/* The board is the content; a keyboard user should not have to walk the bar to reach it. */}
      <a
        href="#room-board"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[30] focus:rounded-[var(--radius-md)] focus:bg-bg-elevated focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
      >
        Skip to the board
      </a>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col p-2 sm:p-3 lg:p-4">
          {/*
            A named landmark so the skip link lands somewhere a screen reader can
            announce. What is written on the paper reaches assistive technology
            through the captions, which are the live region — announcing the
            board's own strokes as well would say everything twice.
          */}
          <section
            id="room-board"
            ref={boardRef}
            tabIndex={-1}
            aria-label={`${firstName}'s board`}
            className="relative min-h-0 flex-1 overflow-hidden rounded-[6px] shadow-board outline-none"
          >
            <BoardSurface session={session} licenseKey={platform.tldrawLicenseKey} />
            <div className="absolute right-2 bottom-2 z-[6] sm:right-3 sm:bottom-3">
              <ExpertOrb
                name={expert?.displayName ?? 'Expert'}
                portraitUrl={portrait}
                presence={presence}
                size={orbSize}
              />
            </div>
            <RoomStatus
              connection={ui.connection}
              soundBlocked={ui.soundBlocked || needsGesture}
              waiting={ui.waiting}
              notice={ui.notice}
              expertFirstName={firstName}
              onEnableSound={enableSound}
              onRetry={() => session?.retryConnection()}
            />
            <CaptionOverlay line={ui.caption} hint={ui.hint} on={ui.captionsOn} />
            {ui.check && session ? (
              <CheckCard
                check={ui.check}
                question={checkQuestion}
                onAnswer={(t) => session.answerCheck(ui.check?.id ?? '', t)}
              />
            ) : null}
            {ui.ad && session ? (
              <VideoAd
                ad={ui.ad}
                locale={state.language}
                onEvent={(name, props) => session.adEvent(name, props)}
                onEnd={(reason) => session.skipAd(reason)}
              />
            ) : null}
            {state.preparation && state.evidenceTier === 'unverified_live_source' ? (
              <div className="absolute top-3 right-3 z-[6]">
                <Pill tone="warm">
                  Preparing {state.preparation.sourcesFetched}/
                  {Math.max(state.preparation.sourcesFound, state.preparation.sourcesFetched)}{' '}
                  sources
                </Pill>
              </div>
            ) : null}
            {state.phase === 'ended' ? (
              <RecapPanel
                state={state}
                expertFirstName={firstName}
                questions={questions}
                onOpenSaved={() => navigate(`/sessions/${id}`)}
                onLearnMore={() => navigate('/')}
              />
            ) : null}
          </section>
          {/* Wide screens keep the question row in the page; a phone gets it as a sheet. */}
          {state.phase === 'live' ? (
            <form
              className="mt-2 hidden items-center gap-2 md:flex"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim() && session) {
                  session.ask(typed.trim());
                  setTyped('');
                }
              }}
            >
              <input
                className="h-9 min-w-0 flex-1 rounded-[var(--radius-md)] bg-surface px-3 text-sm outline-none hairline focus:shadow-[0_0_0_2px_var(--color-accent)]"
                placeholder={`Ask ${firstName} anything — or turn the mic on and just talk`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label="Ask a question"
              />
              <Button
                variant="secondary"
                type="submit"
                disabled={!typed.trim()}
                leading={<Send size={14} />}
              >
                Ask
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      <BottomBar
        state={state}
        isHost={isHost}
        clockMs={ui.clockMs}
        phase={ui.phase}
        micState={ui.micState}
        micLevel={ui.micLevel}
        captionsOn={ui.captionsOn}
        onTogglePlay={() => session?.control(state.mode === 'paused' ? 'resume' : 'pause')}
        onSetPace={(pace) => session?.setPace(pace)}
        onToggleCaptions={() => session?.toggleCaptions()}
        onToggleMic={toggleMic}
        {...(state.phase === 'live' ? { onOpenAsk: () => setAskOpen(true) } : {})}
        onFullscreen={() => {
          trackInteraction('fullscreen');
          void shellRef.current?.requestFullscreen?.();
        }}
        audio={ui.audio}
        selfId={participant?.id ?? ''}
        onMuteParticipant={(pid) =>
          void session
            ?.muteParticipant(pid)
            .then((muted) =>
              toast(
                pid
                  ? 'Muted'
                  : muted.length === 0
                    ? 'Nobody else is on voice'
                    : `Muted ${muted.length} ${muted.length === 1 ? 'person' : 'people'}`,
                'success',
              ),
            )
            .catch(() => toast('Could not mute — try again', 'danger'))
        }
        onUnmuteVoice={() => void session?.unmuteVoice()}
        onLeave={() => {
          if (isHost && state.phase === 'live') session?.control('end');
          else {
            trackInteraction('leave');
            navigate('/');
          }
        }}
      />
      <AskSheet
        open={askOpen}
        onClose={() => setAskOpen(false)}
        expertFirstName={firstName}
        micState={ui.micState}
        micLive={ui.micState === 'listening' && !ui.audio.mutedByHost}
        onToggleMic={toggleMic}
        onAsk={(t) => session?.ask(t)}
      />
    </div>
  );
}
