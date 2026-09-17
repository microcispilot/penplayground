import type { Expert } from '@pen/contracts';
import { Button, ExpertOrb, Pill, useToast } from '@pen/design';
import { MonitorUp, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { BoardSurface } from '../components/BoardSurface.js';
import {
  AdCard,
  BottomBar,
  CaptionOverlay,
  CheckCard,
  PreparingView,
  RecapPanel,
} from '../components/RoomChrome.js';
import { trackInteraction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { RoomSession } from '../room/RoomSession.js';
import { useRoomStore } from '../room/store.js';

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
  const shellRef = useRef<HTMLDivElement>(null);
  const ui = useRoomStore();

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
  const portrait = api.portraitUrl(expert?.portrait?.src);
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
          <AdCard
            durationMs={ui.ad.durationMs}
            skippableAfterMs={ui.ad.skippableAfterMs}
            startedAt={ui.ad.startedAt}
            onSkip={() => session.skipAd()}
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
    <div ref={shellRef} className="flex h-screen flex-col overflow-hidden bg-bg">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[6px] shadow-board">
            <BoardSurface session={session} licenseKey={platform.tldrawLicenseKey} />
            <div
              className={`absolute top-0 left-1/2 z-[3] flex -translate-x-1/2 items-center gap-1.5 rounded-b-[6px] bg-success-soft px-2.5 py-0.5 text-[9px] font-medium text-success transition-opacity ${state.mode === 'teaching' ? 'opacity-100' : 'opacity-0'}`}
            >
              <MonitorUp size={10} /> You're viewing {firstName}'s screen
            </div>
            <div className="absolute right-3 bottom-3 z-[6]">
              <ExpertOrb
                name={expert?.displayName ?? 'Expert'}
                portraitUrl={portrait}
                presence={presence}
                size={88}
              />
            </div>
            <CaptionOverlay line={ui.caption} hint={ui.hint} on={ui.captionsOn} />
            {ui.check && session ? (
              <CheckCard
                check={ui.check}
                question={checkQuestion}
                onAnswer={(t) => session.answerCheck(ui.check?.id ?? '', t)}
              />
            ) : null}
            {ui.ad && session ? (
              <AdCard
                durationMs={ui.ad.durationMs}
                skippableAfterMs={ui.ad.skippableAfterMs}
                startedAt={ui.ad.startedAt}
                onSkip={() => session.skipAd()}
              />
            ) : null}
            {ui.notice ? (
              <div className="absolute top-3 left-3 z-[6]">
                <Pill tone={ui.notice.tone === 'danger' ? 'danger' : 'neutral'}>
                  {ui.notice.text}
                </Pill>
              </div>
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
            {needsGesture ? (
              <div className="absolute inset-0 z-[9] grid place-items-center bg-navy-900/60">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => {
                    setNeedsGesture(false);
                    session
                      ?.start()
                      .then(() => session.enableMic())
                      .catch(() => toast('Audio could not start', 'danger'));
                  }}
                >
                  Join with sound
                </Button>
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
          </div>
          {state.phase === 'live' ? (
            <form
              className="mt-2 flex items-center gap-2"
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
        onToggleMic={() => {
          if (ui.micState === 'listening') {
            session?.disableMic();
            platform.storage.set('pen.mic', 'off');
          } else {
            platform.storage.set('pen.mic', 'on');
            void session?.enableMic();
          }
        }}
        onFullscreen={() => {
          trackInteraction('fullscreen');
          void shellRef.current?.requestFullscreen?.();
        }}
        audio={ui.audio}
        selfId={participant?.id ?? ''}
        onMuteParticipant={(id) =>
          void session
            ?.muteParticipant(id)
            .then((muted) =>
              toast(
                id
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
    </div>
  );
}
