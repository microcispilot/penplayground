import type { Expert } from '@pen/contracts';
import { Button, Pill, useToast } from '@pen/design';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { BoardSurface, preloadBoard } from '../components/BoardSurface.js';
import {
  BottomBar,
  CaptionOverlay,
  CheckCard,
  PreparingView,
  RecapPanel,
  RoomStatus,
} from '../components/RoomChrome.js';
import { SessionPanel, useSessionPanel } from '../components/SessionPanel.js';
import { VideoAd } from '../components/VideoAd.js';
import { trackInteraction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useDocumentLanguage } from '../lib/locale.js';
import { expertPresence } from '../room/presence.js';
import { RoomSession } from '../room/RoomSession.js';
import { useRoomStore } from '../room/store.js';

/** From here the panel is docked beside the board; below it, it comes over the board. */
const DOCK_QUERY = '(min-width: 1024px)';

function useDocked(): boolean {
  const [docked, setDocked] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia(DOCK_QUERY).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(DOCK_QUERY);
    const onChange = () => setDocked(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return docked;
}

/**
 * The live classroom. One RoomSession owns the socket, audio, mic and
 * conductor; this component renders the store and forwards intents.
 *
 * The board is the content and takes the room; everything the learner says and
 * hears — the AI human, everyone else on the call, the conversation and the
 * composer — lives in the session panel on the right, which folds away from
 * its own edge when the board wants the whole width.
 */
export function Room() {
  const { id = '' } = useParams();
  const { api, platform, participant } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [expert, setExpert] = useState<Expert | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  const ui = useRoomStore();
  const docked = useDocked();
  // Remembered across visits, like the shell's own sidebar (ADR-0015).
  const { open: panelOpen, toggle: toggleDockedPanel } = useSessionPanel(platform.storage);
  // On a narrow screen the panel is a drawer over the board: a remembered
  // "open" must not cover the board the instant the room appears.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The board chunk is lazy (it carries tldraw); fetch it while the room is still
  // preparing so the paper is mounted before the first cue, not downloading on it.
  useEffect(() => {
    preloadBoard();
  }, []);
  // The page speaks the session's language: screen readers, hyphenation, and the lang attribute
  // a crawler reads. Direction stays per-text (lib/locale.ts) so the chrome never flips mid-lesson.
  useDocumentLanguage(ui.state?.language);

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
  const presence = expertPresence(ui.state, ui.speaking);
  const checkQuestion = useMemo(
    () => (ui.caption?.who === 'expert' ? ui.caption.text : ''),
    [ui.caption],
  );
  const questions = useMemo(
    () => ui.notes.map((n) => ({ q: n.question, a: `${n.headline} — ${n.detail}` })),
    [ui.notes],
  );
  /** The conversation is on screen, so the board does not repeat it as a caption. */
  const panelShowing = docked ? panelOpen : drawerOpen;
  const adShowing = ui.ad !== null;

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

  const togglePanel = useCallback(() => {
    if (!docked) {
      setDrawerOpen((v) => !v);
      return;
    }
    trackInteraction(panelOpen ? 'panel_collapsed' : 'panel_opened');
    toggleDockedPanel();
  }, [docked, panelOpen, toggleDockedPanel]);

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
  const panel = (
    <SessionPanel
      mode={docked ? 'docked' : 'drawer'}
      open={docked ? panelOpen : drawerOpen}
      onToggle={togglePanel}
      state={state}
      expert={expert}
      expertPresence={presence}
      expertPortraitUrl={portrait}
      soundBlocked={ui.soundBlocked || needsGesture}
      onEnableSound={enableSound}
      isHost={isHost}
      selfId={participant?.id ?? ''}
      audio={ui.audio}
      micState={ui.micState}
      micLevel={ui.micLevel}
      onToggleMic={toggleMic}
      onMute={(pid) =>
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
      conversation={ui.conversation}
      adPaused={adShowing}
      onAsk={(text) => session?.ask(text)}
    />
  );

  return (
    <div ref={shellRef} className="flex h-dvh flex-col overflow-hidden bg-bg">
      {/* The board is the content; a keyboard user should not have to walk the bar to reach it. */}
      <a
        href="#room-board"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[30] focus:rounded-[var(--radius-md)] focus:bg-bg-elevated focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
      >
        Skip to the board
      </a>
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col p-2 sm:p-3 lg:p-4">
          {/*
            A named landmark so the skip link lands somewhere a screen reader can
            announce. What is written on the paper reaches assistive technology
            through the conversation (or, with the panel folded away, the
            captions) — announcing the board's own strokes as well would say
            everything twice.
          */}
          <section
            id="room-board"
            ref={boardRef}
            tabIndex={-1}
            aria-label={`${firstName}'s board`}
            className="relative min-h-0 flex-1 overflow-hidden rounded-[6px] shadow-board outline-none"
          >
            <BoardSurface session={session} licenseKey={platform.tldrawLicenseKey} />
            <RoomStatus
              connection={ui.connection}
              soundBlocked={ui.soundBlocked || needsGesture}
              waiting={ui.waiting}
              notice={ui.notice}
              expertFirstName={firstName}
              onEnableSound={enableSound}
              onRetry={() => session?.retryConnection()}
            />
            {/*
              The conversation is the record the learner can read back; the
              caption is the glance. With the panel up the caption would say the
              same sentence twice — once over the paper, once in the log a
              screen reader is already announcing — so the board keeps its space
              and gets the caption back the moment the panel folds away.
            */}
            {panelShowing ? null : (
              <CaptionOverlay
                line={ui.caption}
                hint={ui.hint}
                on={ui.captionsOn}
                language={state.language}
              />
            )}
            {ui.check && session ? (
              <CheckCard
                check={ui.check}
                question={checkQuestion}
                language={state.language}
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
        </div>
        {panel}
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
        panelOpen={panelShowing}
        onTogglePanel={togglePanel}
        inputsPaused={adShowing}
        onFullscreen={() => {
          trackInteraction('fullscreen');
          void shellRef.current?.requestFullscreen?.();
        }}
        audio={ui.audio}
        selfId={participant?.id ?? ''}
        onUnmuteVoice={() => void session?.unmuteVoice()}
        onLeave={() => {
          if (isHost && state.phase === 'live') session?.control('end');
          else {
            trackInteraction('leave');
            navigate('/');
          }
        }}
      />
    </div>
  );
}
