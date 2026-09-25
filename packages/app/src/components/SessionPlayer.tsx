import type { Expert, Reaction } from '@pen/contracts';
import { Button, cn, Pill, useToast } from '@pen/design';
import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { trackAction, trackInteraction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useDocumentLanguage } from '../lib/locale.js';
import { expertPresence } from '../room/presence.js';
import { RoomSession } from '../room/RoomSession.js';
import { useRoomStore } from '../room/store.js';
import { BoardSurface, preloadBoard } from './BoardSurface.js';
import {
  BottomBar,
  CaptionOverlay,
  CheckCard,
  PreparingView,
  RecapPanel,
  RoomStatus,
} from './RoomChrome.js';
import { SessionPanel, useSessionPanel } from './SessionPanel.js';
import { SoloPresence } from './SoloPresence.js';
import { VideoAd } from './VideoAd.js';

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

export interface SessionPlayerProps {
  sessionId: string;
  /**
   * `full` is the room screen: the whole viewport, browser full-screen on
   * offer, a press on the board doing nothing. `inline` is the watch page's
   * player (ADR-0045): it fills whatever box it is given, a press on the
   * board pauses and resumes, and Full view is the page's to provide.
   */
  layout: 'full' | 'inline';
  /** Leaving the room without ending it: the room screen goes home; the page closes the player. */
  onExit: () => void;
  /** The recap's "open the saved page": the room screen navigates; the page is already there. */
  onOpenSaved: () => void;
  /** Inline only: the page's Full view toggle. */
  onToggleFull?: () => void;
  /** Inline only: whether the page is in full view now, for the button's label. */
  full?: boolean;
}

/**
 * The live classroom. One RoomSession owns the socket, audio, mic and
 * conductor; this component renders the store and forwards intents.
 *
 * The board is the content and takes the room; everything the learner says and
 * hears — the AI human, everyone else on the call, and the chat between the
 * people in the room — lives in the session panel on the right, which folds
 * away from its own edge when the board wants the whole width.
 *
 * Two frames, one classroom (ADR-0045): the room screen renders this at
 * `layout="full"`, the watch page at `layout="inline"`.
 */
/**
 * The check-in card inside whatever element is fullscreen (ADR-0050). When
 * an element is fullscreen the browser draws its subtree alone; a card that
 * is that element's sibling is not hidden by a style, it is not drawn at
 * all. So while something is fullscreen the card is portalled into it, and
 * otherwise it stays where it is, on the board.
 */
function FullscreenPortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.fullscreenElement,
  );
  useEffect(() => {
    const onChange = () => setHost(document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  return host ? createPortal(children, host) : <>{children}</>;
}

export function SessionPlayer({
  sessionId: id,
  layout,
  onExit,
  onOpenSaved,
  onToggleFull,
  full = false,
}: SessionPlayerProps) {
  const { api, platform, participant } = useApp();
  const toast = useToast();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [expert, setExpert] = useState<Expert | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  const ui = useRoomStore();
  const docked = useDocked();
  const inline = layout === 'inline';
  // Remembered across visits, like the shell's own sidebar (ADR-0015).
  const { open: panelOpen, toggle: toggleDockedPanel } = useSessionPanel(platform.storage);
  // On a narrow screen the panel is a drawer over the board: a remembered
  // "open" must not cover the board the instant the room appears.
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** The glyph that flashes on the board when a press pauses or resumes (inline). */
  const [flash, setFlash] = useState<'paused' | 'playing' | null>(null);

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

  /**
   * Inline, an ended session hands the page back the moment it ends: the
   * watch page is the recap — the description, the comments, Up next — and a
   * panel in a small box said less than the page around it (ADR-0050).
   */
  const handedBack = useRef(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (layout !== 'inline' || ui.state?.phase !== 'ended' || handedBack.current) return;
    handedBack.current = true;
    // A beat of fade before the page comes back: a lesson ends, it does not vanish.
    setLeaving(true);
    const timer = window.setTimeout(onOpenSaved, 520);
    return () => window.clearTimeout(timer);
  }, [layout, ui.state?.phase, onOpenSaved]);

  /*
   * The board's width, as a CSS variable on its frame, for the check-in
   * card's sizes (ADR-0050). Measured rather than a container query: the
   * query's layout containment left the card unpainted until a resize in
   * the room screen, and nothing else here wants containment.
   */
  useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = () => el.style.setProperty('--board-w', `${el.clientWidth}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isHost = ui.state?.hostId === participant?.id;
  /**
   * A guest is told the room is being recorded — once, as they take their
   * seat, the way a call says "this meeting is being recorded" (ADR-0035).
   * The recording is the host's alone; that is said too, so nobody has to
   * wonder who can watch them later.
   */
  const noticed = useRef(false);
  useEffect(() => {
    const st = ui.state;
    if (noticed.current || !st || st.phase !== 'live' || !participant) return;
    if (st.hostId === participant.id) return;
    if (!st.participants.some((p) => p.id === participant.id)) return;
    noticed.current = true;
    toast('This session is being recorded. Only the host can watch or download it.', 'neutral');
    trackInteraction('recording_notice_shown');
  }, [ui.state, participant, toast]);
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
  /** Whether the panel is on screen: docked beside the board, or drawn over it. */
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

  const togglePlay = useCallback(() => {
    const st = ui.state;
    if (!session || !st || st.phase !== 'live') return;
    // The player's own phase decides, not the room's mode: a pause pressed
    // mid-answer is honoured by the room when the answer ends, and by then
    // the room's mode and the player's state had drifted apart (ADR-0050).
    const next = ui.phase === 'paused' || st.mode === 'paused' ? 'resume' : 'pause';
    session.control(next);
    if (inline) {
      setFlash(next === 'pause' ? 'paused' : 'playing');
      window.setTimeout(() => setFlash(null), 600);
    }
  }, [session, ui.state, ui.phase, inline]);

  if (ui.errorText) {
    return (
      <div
        className={cn(
          'grid place-items-center bg-surface px-7',
          inline ? 'h-full' : 'min-h-screen',
        )}
        data-testid="session-player"
        data-layout={layout}
        data-phase="error"
      >
        <div className="flex max-w-[420px] flex-col items-center gap-4 text-center">
          <p className="text-body-large text-on-surface">{ui.errorText}</p>
          <Button variant="primary" onClick={onExit}>
            {inline ? 'Close' : 'Back to Explore'}
          </Button>
        </div>
      </div>
    );
  }

  if (!ui.state || ui.state.phase === 'preparing') {
    return (
      <div
        className={cn('relative', inline && 'h-full overflow-hidden')}
        data-testid="session-player"
        data-layout={layout}
        data-phase="preparing"
      >
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
          compact={inline}
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
  /**
   * One learner and an expert is the ordinary session, and it does not need a
   * panel: a roster of two and a chat nobody else can read are furniture
   * pretending to be features (ADR-0033). The panel appears when there is
   * somebody to see and somebody to talk to, and `SoloExpert` carries the
   * only part of it that still means something alone.
   */
  const solo = state.participants.length <= 1;
  /**
   * The room's furniture, decided by the host's plan and platform when the
   * room was built (ADR-0036): the server says what exists here, and every
   * client draws the same room. Absent on an older ledger means all of it.
   */
  const furniture = state.features ?? { chat: true, reactions: true, captions: true };
  const panel = (
    <SessionPanel
      mode={docked && !inline ? 'docked' : 'drawer'}
      open={docked && !inline ? panelOpen : drawerOpen}
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
      onRemove={
        isHost
          ? (pid) => {
              session?.removeParticipant(pid);
              toast('Removed from the room', 'success');
            }
          : null
      }
      chat={ui.chat}
      chatEnabled={furniture.chat}
      reactions={ui.reactions}
      adPaused={adShowing}
      onSend={(text) => session?.sendChat(text)}
    />
  );
  /** A press on the board pauses and resumes, inline only, and only while the lesson is live. */
  const pressToPause = inline && solo && state.phase === 'live' && !adShowing;

  return (
    <div
      ref={shellRef}
      className={cn('flex flex-col overflow-hidden bg-surface', inline ? 'h-full w-full' : 'h-dvh')}
      data-testid="session-player"
      data-layout={layout}
      data-phase="live"
    >
      {inline ? null : (
        // The board is the content; a keyboard user should not have to walk the bar to reach it.
        <a
          href="#room-board"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[30] focus:rounded-md focus:bg-surface-container focus:px-3 focus:py-2 focus:text-body-medium focus:shadow-level3"
        >
          Skip to the board
        </a>
      )}
      <div className="relative flex min-h-0 flex-1">
        {/*
          The wall (ADR-0051): a board hangs on something. The room's surface
          colour around the frame, with room to breathe, so the board reads as
          an object in a space rather than a texture filling the viewport.
        */}
        <div
          className={cn(
            'pen-wall flex min-w-0 flex-1 flex-col transition-opacity duration-500 ease-out',
            inline ? 'p-3 sm:p-4' : 'p-3 sm:p-5 lg:p-8',
            leaving && 'opacity-0',
          )}
          data-testid="board-wall"
        >
          {/*
            A named landmark so the skip link lands somewhere a screen reader can
            announce. What is written on the paper reaches assistive technology
            through the captions, which are a live region — announcing the
            board's own strokes as well would say everything twice.
          */}
          <section
            id="room-board"
            ref={boardRef}
            tabIndex={-1}
            aria-label={`${firstName}'s board`}
            className="pen-board-frame relative min-h-0 flex-1 overflow-hidden outline-none"
          >
            <BoardSurface session={session} licenseKey={platform.tldrawLicenseKey} />
            {pressToPause ? (
              /*
               * The press layer (ADR-0045): over the paper, under every overlay
               * that is itself pressed — the check-in card, the sound button,
               * the nudge, the recap — so those keep working. Named for what
               * it does; the bar's own button says the same thing.
               */
              <button
                type="button"
                aria-label={state.mode === 'paused' ? 'Resume' : 'Pause'}
                className="absolute inset-0 z-[3] cursor-pointer bg-transparent"
                onClick={togglePlay}
                data-testid="board-press"
              />
            ) : null}
            {flash ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[4] grid place-items-center"
              >
                <span className="animate-rise grid size-16 place-items-center rounded-full bg-white text-primary-fixed shadow-[0_2px_4px_rgba(0,0,0,0.16),0_12px_32px_rgba(0,0,0,0.28)]">
                  {flash === 'paused' ? (
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  ) : (
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </span>
              </div>
            ) : null}
            <RoomStatus
              connection={ui.connection}
              soundBlocked={ui.soundBlocked || needsGesture}
              waiting={ui.waiting}
              notice={ui.notice}
              expertFirstName={firstName}
              onEnableSound={enableSound}
              onRetry={() => session?.retryConnection()}
            />
            {ui.nudge === 'questions' ? (
              /*
               * The way forward, beside what the expert just said (ADR-0040):
               * the question was heard, and answers are a paid plan's. Calm —
               * the brand's fill on the one action, no error role — and gone
               * with one tap or the next question.
               */
              <div
                role="status"
                data-testid="room-nudge"
                className="animate-rise absolute right-3 bottom-3 left-3 z-[20] mx-auto flex max-w-[520px] flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface-container px-4 py-3 shadow-level2 sm:left-auto"
              >
                <p className="min-w-0 flex-1 text-body-medium text-on-surface text-pretty">
                  {firstName} heard you. Answering questions live comes with a paid plan.
                </p>
                <Link
                  to="/pricing"
                  onClick={() => trackAction('upgrade_clicked', { source: 'room_questions' })}
                  className="state-layer inline-flex h-9 shrink-0 items-center rounded-full bg-primary-fixed px-4 text-label-large text-on-primary-fixed"
                >
                  See the plans
                </Link>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="state-layer grid size-8 shrink-0 place-items-center rounded-full text-on-surface-variant"
                  onClick={() => useRoomStore.getState().set({ nudge: null })}
                >
                  <X size={16} />
                </button>
              </div>
            ) : null}
            {/*
              Captions, when they are asked for — and never twice. Nothing in
              the panel repeats what was said any more, so this is the only
              place the words appear, whether the panel is up or folded away.
              It is off until the CC control turns it on (`store.ts`).
            */}
            <CaptionOverlay
              line={ui.caption}
              hint={ui.hint}
              on={furniture.captions && ui.captionsOn}
              language={state.language}
            />
            {ui.check && session ? (
              <FullscreenPortal>
                <CheckCard
                  check={ui.check}
                  question={ui.check.question ?? checkQuestion}
                  language={state.language}
                  onAnswer={(t) => session.answerCheck(ui.check?.id ?? '', t)}
                />
              </FullscreenPortal>
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
            {solo && state.phase !== 'ended' ? (
              <SoloPresence
                expert={expert}
                presence={presence}
                portraitUrl={portrait}
                self={state.participants.find((p) => p.id === participant?.id) ?? null}
                audio={ui.audio}
                soundBlocked={ui.soundBlocked || needsGesture}
                onEnableSound={enableSound}
                compact={inline && !full}
              />
            ) : null}
            {state.phase === 'ended' && !inline ? (
              <RecapPanel
                state={state}
                expertFirstName={firstName}
                questions={questions}
                onOpenSaved={onOpenSaved}
                onLearnMore={onExit}
                savedIsHere={inline}
              />
            ) : null}
          </section>
        </div>
        {solo ? null : panel}
      </div>
      <BottomBar
        state={state}
        isHost={isHost}
        clockMs={ui.clockMs}
        phase={ui.phase}
        micState={ui.micState}
        micLevel={ui.micLevel}
        captionsOn={ui.captionsOn}
        captionsAvailable={furniture.captions}
        recording={!solo}
        onTogglePlay={togglePlay}
        onSetPace={(pace) => session?.setPace(pace)}
        onToggleCaptions={() => session?.toggleCaptions()}
        onToggleMic={toggleMic}
        {...(solo
          ? {}
          : {
              panelOpen: panelShowing,
              onTogglePanel: togglePanel,
              // The floor in a room (ADR-0037): the host's discussion, a guest's hand.
              ...(isHost
                ? { onToggleDiscuss: () => session?.discuss(state.mode !== 'discussing') }
                : { onToggleHand: () => session?.setHand(!ui.handRaised) }),
              ...(furniture.reactions
                ? { onReact: (emoji: Reaction) => session?.react(emoji) }
                : {}),
            })}
        inputsPaused={adShowing}
        fullscreenLabel={inline ? (full ? 'Exit full view' : 'Full view') : 'Full screen'}
        fullscreenAlways={inline}
        compact={inline && !full}
        onFullscreen={() => {
          if (inline) {
            trackAction('full_view_toggled', { sessionId: id, full: !full });
            onToggleFull?.();
            return;
          }
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
            onExit();
          }
        }}
      />
    </div>
  );
}
