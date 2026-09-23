import type { CheckEvent, Reaction, RoomState } from '@pen/contracts';
import {
  Avatar,
  Button,
  Caption,
  cn,
  IconButton,
  IconButtonGroup,
  Pill,
  SegmentDots,
  Sheet,
  SheetRow,
} from '@pen/design';
import {
  Captions,
  Ellipsis,
  Gauge,
  Hand,
  Maximize2,
  MessagesSquare,
  Mic,
  MicOff,
  PanelRight,
  Pause,
  Play,
  Send,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { formatClock } from '../lib/context.js';
import { dirOf } from '../lib/locale.js';
import type { RoomAudioUi } from '../room/audio/RoomAudio.js';
import type { RoomConnectionStatus } from '../room/RoomClient.js';
import type { CaptionLine } from '../room/store.js';
import { PaceMenu } from './PaceMenu.js';
import { ReactionPicker } from './Reactions.js';

// ── honest status ─────────────────────────────────────────────────────────────

/**
 * One calm line, never more than one at a time, for every state in which the
 * learner would otherwise be looking at stillness: the socket is away, the
 * browser is holding the sound, or the expert owes a sentence. Deliberately
 * quiet — a small pill in the room's own colours, no alarm, no exclamation —
 * because none of these is the learner's fault or emergency.
 */
export interface RoomStatusProps {
  connection: RoomConnectionStatus;
  soundBlocked: boolean;
  waiting: boolean;
  notice: { text: string; tone: 'neutral' | 'danger' } | null;
  expertFirstName: string;
  onEnableSound: () => void;
  onRetry: () => void;
}

/** How long "Back." stays up after a reconnection before the room goes quiet again. */
const BACK_MS = 2400;

export function RoomStatus({
  connection,
  soundBlocked,
  waiting,
  notice,
  expertFirstName,
  onEnableSound,
  onRetry,
}: RoomStatusProps) {
  const [recovered, setRecovered] = useState(false);
  const wasAway = useRef(false);

  useEffect(() => {
    if (connection === 'reconnecting' || connection === 'failed') {
      wasAway.current = true;
      setRecovered(false);
      return;
    }
    if (connection === 'open' && wasAway.current) {
      wasAway.current = false;
      setRecovered(true);
      const t = setTimeout(() => setRecovered(false), BACK_MS);
      return () => clearTimeout(t);
    }
    return;
  }, [connection]);

  let content: ReactNode = null;
  let testid = '';
  if (connection === 'reconnecting') {
    content = <StatusPill testid="status-reconnecting" pulse text="Reconnecting…" />;
    testid = 'status-reconnecting';
  } else if (connection === 'failed') {
    content = <StatusButton testid="status-retry" onClick={onRetry} text="Tap to reconnect" />;
    testid = 'status-retry';
  } else if (recovered) {
    content = <StatusPill testid="status-back" text="Back." />;
    testid = 'status-back';
  } else if (soundBlocked) {
    content = (
      <StatusButton
        testid="status-sound"
        onClick={onEnableSound}
        text={`Tap to hear ${expertFirstName}`}
      />
    );
    testid = 'status-sound';
  } else if (waiting) {
    content = <StatusPill testid="status-waiting" pulse text={`${expertFirstName} is thinking…`} />;
    testid = 'status-waiting';
  } else if (notice) {
    content = <StatusPill testid="status-notice" text={notice.text} />;
    testid = 'status-notice';
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-2.5 z-[8] flex justify-center px-3"
      // One live region for the room's whole status: a screen reader hears the
      // change, and only the change, without the board's chatter.
      aria-live="polite"
      data-status={testid || 'none'}
    >
      {content}
    </div>
  );
}

const STATUS_BASE =
  'pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-surface-container/92 px-3 py-1.5 text-body-small text-on-surface-variant shadow-level1 backdrop-blur-[6px] hairline';

function StatusPill({ text, pulse, testid }: { text: string; pulse?: boolean; testid: string }) {
  return (
    <span className={cn(STATUS_BASE, 'animate-rise')} data-testid={testid}>
      {pulse ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-on-surface-dim animate-blink"
          aria-hidden
        />
      ) : null}
      <span className="truncate">{text}</span>
    </span>
  );
}

function StatusButton({
  text,
  onClick,
  testid,
}: {
  text: string;
  onClick: () => void;
  testid: string;
}) {
  return (
    // The whole pill is the control: nothing to aim at, no second step.
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={cn(
        STATUS_BASE,
        'animate-rise text-on-surface transition-colors duration-[var(--duration-fast)] hover:bg-surface-container focus-visible:outline-primary',
      )}
    >
      <span className="truncate">{text}</span>
    </button>
  );
}

/**
 * The same one calm line, on a screen that has no room status of its own.
 *
 * A replay has no socket to lose and no floor to wait for, so it does not want
 * `RoomStatus`; it wants the one case it can still hit — a sentence whose audio
 * the browser refused to play, which the player recovers from by timing it off
 * the wall clock (`MEDIA_STALL_TIMEOUT_MS`). Saying so beats a viewer wondering
 * why the expert went quiet.
 */
export function ReplayNotice({
  notice,
}: {
  notice: { text: string; tone: 'neutral' | 'danger' } | null;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-2.5 z-[8] flex justify-center px-3"
      aria-live="polite"
      data-status={notice ? 'status-notice' : 'none'}
    >
      {notice ? <StatusPill testid="status-notice" text={notice.text} /> : null}
    </div>
  );
}

// ── bottom bar ────────────────────────────────────────────────────────────────
export interface BottomBarProps {
  state: RoomState;
  isHost: boolean;
  clockMs: number;
  phase: string;
  micState: 'idle' | 'starting' | 'listening' | 'denied' | 'error';
  micLevel: number;
  captionsOn: boolean;
  /** The CC control exists in this room at all (ADR-0036). Absent means yes. */
  captionsAvailable?: boolean;
  /**
   * The floor in a room (ADR-0037). A guest raises a hand to be called on;
   * the host opens and closes a discussion. Absent in a solo session, where
   * the learner is heard without either.
   */
  handRaised?: boolean;
  onToggleHand?: () => void;
  onToggleDiscuss?: () => void;
  /**
   * There are guests, so the room is being recorded for its host and everyone
   * is told, the way a call shows its recording dot (ADR-0035).
   */
  recording?: boolean;
  onTogglePlay: () => void;
  /** Host only; guests see the pill disabled. */
  onSetPace: (pace: number) => void;
  onToggleCaptions: () => void;
  onToggleMic: () => void;
  onFullscreen: () => void;
  onLeave: () => void;
  /**
   * The session panel — the AI human, the call and the chat — is open.
   * The panel carries its own chevron on its edge; this is the way back to it
   * once it has folded away, and the way to it on a screen too narrow to dock
   * it. Absent while the room is not live.
   */
  panelOpen?: boolean;
  onTogglePanel?: () => void;
  /**
   * Say something without taking the floor (`reactions.ts`). Absent while the
   * room is not live; off, with the rest of the inputs, behind an ad.
   */
  onReact?: (emoji: Reaction) => void;
  /**
   * An ad is on the board (free plan, ADR-0014): the microphone is not
   * capturing and the composer is off for its duration. Said once, quietly —
   * this is an ordinary state, not a fault.
   */
  inputsPaused?: boolean;
  /** Human-to-human audio (rooms): who is on voice, speaking, muted. */
  audio?: RoomAudioUi;
  selfId?: string;
  onUnmuteVoice?: () => void;
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

/**
 * The recording mark a call carries while it is recorded: a steady dot and
 * the word, in the ordinary voice. A fact about the room, never a warning.
 */
function RecordingDot() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-body-small text-on-surface-variant"
      data-testid="recording-dot"
      title="This session is being recorded for its host"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      Recording
    </span>
  );
}

/** What the room is doing, in the learner's words. */
function statusLabelOf(state: RoomState, total: number, selfId?: string): string {
  switch (state.mode) {
    case 'listening':
      if (selfId && state.floor !== selfId) {
        const name = state.participants.find((p) => p.id === state.floor)?.name ?? 'Someone';
        return state.invited === state.floor ? `${name} was called on` : `${name} has the floor`;
      }
      return state.invited === selfId
        ? 'Go ahead — the expert is listening'
        : 'Paused — you have the floor';
    case 'discussing':
      return 'Discussion — the expert is waiting';
    case 'thinking':
      return 'Thinking…';
    case 'answering':
      return 'Answering you';
    case 'checking':
      return 'Your turn to answer';
    case 'complete':
      return `Complete · step ${total} of ${total}`;
    case 'paused':
      return `Paused · step ${Math.max(1, state.segment + 1)} of ${total}`;
    default:
      return `Step ${Math.max(1, state.segment + 1)} of ${total}`;
  }
}

export function BottomBar(p: BottomBarProps) {
  const [more, setMore] = useState(false);
  const total = p.state.plan?.segments.length ?? 0;
  const done = p.state.mode === 'complete' ? total : Math.min(total, p.state.segment);
  const playing = p.state.mode !== 'paused';
  const statusLabel = statusLabelOf(p.state, total, p.selfId);
  const discussing = p.state.mode === 'discussing';
  const myHand = p.state.hands?.findIndex((h) => h.participantId === p.selfId) ?? -1;
  const handLabel =
    myHand >= 0
      ? `Hand up${myHand > 0 ? ` · ${ordinal(myHand + 1)} in line` : ' · you are next'} — lower it`
      : p.state.invited === p.selfId
        ? 'The expert called on you — go ahead'
        : 'Raise your hand to ask the expert';
  const micLive = p.micState === 'listening' && !p.audio?.mutedByHost && !p.inputsPaused;
  const micLabel = p.inputsPaused
    ? 'Microphone is off while the ad plays'
    : p.audio?.mutedByHost
      ? 'Muted by the host — unmute'
      : p.micState === 'listening'
        ? 'Mute microphone'
        : 'Unmute microphone';
  const onMic = p.audio?.mutedByHost && p.onUnmuteVoice ? p.onUnmuteVoice : p.onToggleMic;
  const canPlayPause =
    p.state.phase === 'live' && p.state.mode !== 'listening' && p.state.mode !== 'answering';

  return (
    <>
      <div
        className="flex shrink-0 items-center gap-2 border-t border-outline-variant bg-surface-container-low px-2.5 pb-[env(safe-area-inset-bottom)] sm:gap-3 sm:px-3.5"
        style={{ minHeight: 56 }}
      >
        <span
          className="hidden size-[26px] shrink-0 place-items-center rounded-full bg-primary text-body-small text-on-primary sm:grid"
          aria-hidden
        >
          ◇
        </span>
        {/* Title and status: the first thing to go when the screen narrows. */}
        <div className="hidden min-w-0 flex-auto items-center gap-2.5 border-l border-outline pl-2.5 md:flex">
          <span className="min-w-0 truncate text-body-medium text-on-surface">
            {p.state.plan?.title ?? p.state.topic}
          </span>
          {p.state.mode === 'complete' ? <Pill tone="accent">Complete</Pill> : null}
          {p.recording ? <RecordingDot /> : null}
          <span
            className="hidden text-body-small text-on-surface-dim lg:inline"
            data-testid="room-status-label"
          >
            {statusLabel}
          </span>
        </div>
        {/* On a phone the same sentence is the only thing worth the width. */}
        <span className="min-w-0 flex-auto truncate text-body-small text-on-surface-variant md:hidden">
          {statusLabel}
        </span>
        {total > 0 ? (
          <SegmentDots
            total={total}
            done={done}
            active={p.state.segment}
            className="hidden sm:flex"
          />
        ) : null}
        <span className="hidden shrink-0 text-body-medium text-on-surface-variant tabular sm:inline">
          {formatClock(p.clockMs)}
        </span>
        <IconButtonGroup label="Room controls" className="shrink-0">
          {p.isHost ? (
            <IconButton
              label={playing ? 'Pause' : 'Resume'}
              onClick={p.onTogglePlay}
              disabled={!canPlayPause || discussing}
              className="hidden md:grid"
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
          ) : null}
          {p.isHost && p.onToggleDiscuss ? (
            // The class talks among themselves; the expert waits (ADR-0037).
            <IconButton
              label={discussing ? 'Back to the expert' : 'Discuss — pause the expert'}
              state={discussing ? 'on' : 'default'}
              onClick={p.onToggleDiscuss}
              disabled={p.inputsPaused ?? false}
              data-testid="discuss-toggle"
            >
              <MessagesSquare size={16} />
            </IconButton>
          ) : null}
          {!p.isHost && p.onToggleHand ? (
            <IconButton
              label={handLabel}
              state={myHand >= 0 || p.state.invited === p.selfId ? 'on' : 'default'}
              onClick={p.onToggleHand}
              disabled={(p.inputsPaused ?? false) || p.state.invited === p.selfId}
              size={44}
              className="relative sm:[--icon-size:32px]"
              data-testid="hand-toggle"
            >
              <Hand size={20} />
              {myHand > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-primary text-[10px] text-on-primary tabular-nums"
                >
                  {myHand + 1}
                </span>
              ) : null}
            </IconButton>
          ) : null}
          <PaceMenu
            value={p.state.pace}
            onChange={p.onSetPace}
            disabled={!p.isHost}
            disabledReason="Only the host sets the pace"
            className="hidden md:block"
          />
          {(p.captionsAvailable ?? true) ? (
            <IconButton
              label="Captions"
              state={p.captionsOn ? 'on' : 'default'}
              onClick={p.onToggleCaptions}
              className="hidden sm:grid"
            >
              <Captions size={16} />
            </IconButton>
          ) : null}
          {/* The microphone is the point of the product, so on a phone it is the biggest thing here. */}
          <IconButton
            label={micLabel}
            state={
              p.inputsPaused
                ? 'default'
                : p.audio?.mutedByHost
                  ? 'warn'
                  : p.micState === 'listening'
                    ? 'on'
                    : p.micState === 'denied'
                      ? 'warn'
                      : 'default'
            }
            onClick={onMic}
            disabled={p.inputsPaused ?? false}
            size={44}
            className="relative sm:[--icon-size:32px]"
            data-testid="mic-toggle"
          >
            {micLive ? <Mic size={20} /> : <MicOff size={20} />}
            {micLive ? (
              <>
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full ring-2 ring-presence/60"
                  style={{ opacity: Math.min(1, p.micLevel * 12) }}
                />
                {/* Live is a ring and a dot, the way a call marks it. */}
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-presence animate-blink"
                />
              </>
            ) : null}
          </IconButton>
          {p.onReact ? (
            <ReactionPicker
              disabled={p.inputsPaused ?? false}
              disabledReason="Reactions are back after the ad"
              onReact={p.onReact}
            />
          ) : null}
          {p.onTogglePanel ? (
            <IconButton
              label={p.panelOpen ? 'Hide the session panel' : 'Show the session panel'}
              onClick={p.onTogglePanel}
              aria-expanded={p.panelOpen ?? false}
              className={cn(p.panelOpen && 'bg-surface-container-high text-on-surface')}
              data-testid="panel-toggle"
            >
              <PanelRight size={17} />
            </IconButton>
          ) : null}
          <IconButton label="Full screen" onClick={p.onFullscreen} className="hidden lg:grid">
            <Maximize2 size={15} />
          </IconButton>
          <IconButton
            label="More controls"
            onClick={() => setMore(true)}
            className="md:hidden"
            data-testid="more-controls"
          >
            <Ellipsis size={18} />
          </IconButton>
        </IconButtonGroup>
        <Button variant="neutral" size="sm" onClick={p.onLeave} className="shrink-0">
          {p.isHost ? 'End' : 'Leave'}
        </Button>
      </div>

      {/* Everything the wide bar shows at once, with the labels spelled out. */}
      <Sheet
        open={more}
        onClose={() => setMore(false)}
        title={p.state.plan?.title ?? p.state.topic}
        data-testid="more-sheet"
      >
        <p className="mb-2 px-3 text-body-medium text-on-surface-variant">
          {statusLabel} · {formatClock(p.clockMs)}
        </p>
        {total > 0 ? (
          <div className="mb-2 px-3">
            <SegmentDots total={total} done={done} active={p.state.segment} />
          </div>
        ) : null}
        {p.isHost ? (
          <SheetRow
            label={playing ? 'Pause' : 'Resume'}
            icon={playing ? <Pause size={16} /> : <Play size={16} />}
            disabled={!canPlayPause || discussing}
            onClick={() => {
              p.onTogglePlay();
              setMore(false);
            }}
          />
        ) : null}
        {p.isHost && p.onToggleDiscuss ? (
          <SheetRow
            label={discussing ? 'Back to the expert' : 'Discuss — pause the expert'}
            hint={discussing ? 'On' : 'Off'}
            icon={<MessagesSquare size={16} />}
            pressed={discussing}
            onClick={() => {
              p.onToggleDiscuss?.();
              setMore(false);
            }}
          />
        ) : null}
        {(p.captionsAvailable ?? true) ? (
          <SheetRow
            label="Captions"
            hint={p.captionsOn ? 'On' : 'Off'}
            icon={<Captions size={16} />}
            pressed={p.captionsOn}
            onClick={p.onToggleCaptions}
          />
        ) : null}
        <div className="flex items-center justify-between gap-3 rounded-md px-3 py-3">
          <span className="flex items-center gap-3 text-body-medium text-on-surface">
            <Gauge size={16} className="shrink-0" aria-hidden />
            Pace
          </span>
          <PaceMenu
            value={p.state.pace}
            onChange={p.onSetPace}
            disabled={!p.isHost}
            disabledReason="Only the host sets the pace"
          />
        </div>
        <SheetRow
          label="Full screen"
          icon={<Maximize2 size={16} />}
          onClick={() => {
            p.onFullscreen();
            setMore(false);
          }}
        />
      </Sheet>
    </>
  );
}

// ── captions ──────────────────────────────────────────────────────────────────
export function CaptionOverlay({
  line,
  hint,
  on,
  language,
}: {
  line: CaptionLine | null;
  hint: string | null;
  on: boolean;
  /** The session's language: Persian, Arabic and Hebrew captions read right to left. */
  language?: string;
}) {
  /*
   * Subtitles, the way a film does them: **one sentence, whole, at a time.**
   *
   * This used to reveal the sentence letter by letter, paced to the audio. It
   * read as a machine typing rather than as a person speaking — the owner:
   * *"CC should be like in movies, one sentence at a time shown synced."*
   * Right, and for a reason beyond taste: a caption exists for somebody who
   * cannot rely on the audio, and a line that is still arriving is a line
   * they cannot read at their own speed. A film subtitle is complete the
   * moment it appears and is gone when the next one starts.
   *
   * The sync is the room's already: the caption *is* `line`, and the room
   * replaces it per spoken sentence. So there is nothing to animate and
   * nothing to time here — which is why `revealMs` is no longer read.
   */
  const shown = line?.text ?? '';
  // Centred and measured, like a subtitle: a sentence running the whole width
  // of a 1440 board is a line nobody can read in one movement. ~46 characters
  // is roughly what broadcast subtitling allows per line.
  const box =
    'pointer-events-none absolute inset-x-3 bottom-3 z-[5] flex justify-center sm:inset-x-5 sm:bottom-[18px] lg:inset-x-6 lg:bottom-[22px]';
  if (!on || !line)
    return hint ? (
      <div className={cn(box, 'text-center')} data-caption-box>
        <span
          className="inline rounded-xs px-[0.4em] py-[0.18em] text-body-small text-white/85"
          style={{ background: 'var(--color-caption-scrim)' }}
        >
          {hint}
        </span>
      </div>
    ) : null;
  return (
    <div className={box} data-caption-box data-testid="caption">
      <Caption
        className="max-w-[46ch]"
        text={shown || '…'}
        live={line.live}
        {...(language ? { lang: language, dir: dirOf(language) } : {})}
        {...(hint ? { hint } : {})}
      />
    </div>
  );
}

// ── check-in card ─────────────────────────────────────────────────────────────
export function CheckCard({
  check,
  question,
  onAnswer,
  language,
}: {
  check: CheckEvent;
  question: string;
  onAnswer: (text: string) => void;
  /** The check is asked in the session's language, so it reads in its direction. */
  language?: string;
}) {
  const [text, setText] = useState('');
  return (
    <div className="absolute inset-x-2 bottom-3 z-[6] mx-auto max-h-[70%] w-[min(560px,100%)] animate-rise overflow-y-auto rounded-lg bg-surface-container p-4 shadow-level3 sm:inset-x-0 sm:bottom-[70px] sm:w-[min(560px,90%)]">
      <div className="mb-1 text-label-small font-medium tracking-widest text-primary uppercase">
        Quick check
      </div>
      <p
        className="mb-3 text-body-medium font-medium leading-snug text-on-surface text-pretty"
        {...(language ? { lang: language, dir: dirOf(language) } : { dir: 'auto' as const })}
      >
        {question}
      </p>
      {check.options.length > 0 ? (
        <div className="flex flex-col gap-2">
          {check.options.map((o) => (
            <Button
              key={o}
              variant="secondary"
              className="justify-start text-start"
              dir="auto"
              onClick={() => onAnswer(o)}
            >
              {o}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onAnswer(text.trim());
        }}
      >
        <input
          className="h-9 min-w-0 flex-1 rounded-md bg-surface-container-low px-3 text-body-medium outline-none hairline focus:shadow-[0_0_0_2px_var(--color-primary)]"
          placeholder="Or say it out loud — or type here"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Your answer"
        />
        <IconButton label="Send answer" type="submit">
          <Send size={15} />
        </IconButton>
      </form>
    </div>
  );
}

// ── recap panel ───────────────────────────────────────────────────────────────
export function RecapPanel({
  state,
  expertFirstName,
  questions,
  onOpenSaved,
  onLearnMore,
}: {
  state: RoomState;
  expertFirstName: string;
  questions: Array<{ q: string; a: string }>;
  onOpenSaved: () => void;
  onLearnMore: () => void;
}) {
  // The lesson's own words — title, recap, the learner's questions — read in its direction.
  const lang = state.language;
  const dir = dirOf(lang);
  return (
    <div className="absolute inset-0 z-[7] flex justify-end bg-scrim/70">
      {/* A drawer on a wide screen; the whole screen on a phone, where a drawer is just a cramped page. */}
      <div className="h-full w-full animate-rise overflow-auto bg-surface px-5 pt-6 pb-8 shadow-[-20px_0_50px_rgba(0,0,0,.5)] sm:w-[min(430px,86%)] sm:px-6">
        <h6 className="mb-2 text-primary">Session saved</h6>
        <h3 className="mb-1.5 text-pretty" lang={lang} dir={dir}>
          {state.plan?.title ?? state.topic}
        </h3>
        <p className="mb-[22px] text-body-medium text-on-surface-variant">
          {expertFirstName} · {formatClock(state.clockMs)} · {questions.length} question
          {questions.length === 1 ? '' : 's'}
        </p>
        <h6 className="mb-2.5 text-on-surface-variant">What {expertFirstName} covered</h6>
        <div className="mb-6 flex flex-col gap-2" lang={lang} dir={dir}>
          {(state.recap ?? []).map((r) => (
            <div key={r} className="flex items-start gap-2.5">
              <span className="mt-2 size-[5px] shrink-0 rounded-full bg-primary" aria-hidden />
              <span className="text-body-medium text-on-surface-variant">{r}</span>
            </div>
          ))}
        </div>
        <h6 className="mb-2.5 text-on-surface-variant">Your questions</h6>
        <div className="mb-[26px] flex flex-col gap-3">
          {questions.length === 0 ? (
            <p className="text-body-medium text-on-surface-dim">
              You didn't stop {expertFirstName} this time. Next one, jump in whenever.
            </p>
          ) : (
            questions.map((q) => (
              <div key={q.q} className="border-primary border-s-2 ps-[11px]" lang={lang} dir={dir}>
                <p className="mb-1 text-body-medium text-on-surface">{q.q}</p>
                <p className="text-body-medium text-on-surface-variant">{q.a}</p>
              </div>
            ))
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" onClick={onOpenSaved}>
            Open the saved session
          </Button>
          <Button variant="secondary" size="lg" onClick={onLearnMore}>
            Learn something else
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── preparing ─────────────────────────────────────────────────────────────────
export function PreparingView({
  expertName,
  expertRole,
  portraitUrl,
  topic,
  plan,
  progress,
}: {
  expertName: string;
  expertRole: string;
  portraitUrl: string | null;
  topic: string;
  plan: RoomState['plan'];
  progress: { fraction: number; status: string } | null;
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-surface px-7 py-12">
      <div className="flex w-full max-w-[380px] flex-col items-center text-center">
        <div
          className={cn(
            'size-[92px] overflow-hidden rounded-full bg-surface-container-high shadow-[0_0_0_3px_oklch(1_0_0/10%)] animate-ring',
          )}
        >
          {portraitUrl ? (
            <img
              src={portraitUrl}
              alt={expertName}
              width={92}
              height={92}
              decoding="async"
              className="size-full object-cover"
            />
          ) : (
            <Avatar name={expertName} size={92} />
          )}
        </div>
        <div className="mt-4 text-body-medium font-medium text-on-surface">{expertName}</div>
        <div className="mt-0.5 text-body-small text-on-surface-dim">
          AI expert · {expertRole.toLowerCase()}
        </div>
        <div className="my-[26px] h-px w-11 bg-outline" />
        <div className="text-title-large font-medium text-on-surface text-pretty">
          {plan?.title ?? topic}
        </div>
        <div className="mt-[7px] text-body-small text-on-surface-dim">
          {plan
            ? `${plan.segments.length} steps · about ${Math.round(plan.seconds / 60)} minutes`
            : 'Getting the material together'}
        </div>
        <div className="mt-[34px] h-0.5 w-full overflow-hidden rounded-full bg-surface-container-high">
          <div
            className="h-full bg-primary transition-[width] duration-[var(--duration-scene)] ease-[var(--ease-out)]"
            style={{ width: `${Math.round((progress?.fraction ?? 0.05) * 100)}%` }}
          />
        </div>
        <div className="mt-3.5 flex items-center gap-2" aria-live="polite">
          <span className="block size-[13px] animate-spin rounded-full border-2 border-outline border-t-accent" />
          <span className="text-body-medium text-on-surface-variant">
            {progress?.status ?? 'Connecting…'}
          </span>
        </div>
      </div>
    </div>
  );
}
