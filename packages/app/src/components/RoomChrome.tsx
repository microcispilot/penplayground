import type { CheckEvent, RoomState } from '@pen/contracts';
import { Avatar, Button, Caption, cn, IconButton, Pill, SegmentDots } from '@pen/design';
import { Captions, Maximize2, Mic, MicOff, Pause, Play, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatClock } from '../lib/context.js';
import type { RoomAudioUi } from '../room/audio/RoomAudio.js';
import type { CaptionLine } from '../room/store.js';
import { PaceMenu } from './PaceMenu.js';
import { ParticipantsControl } from './Participants.js';

// ── bottom bar ────────────────────────────────────────────────────────────────
export interface BottomBarProps {
  state: RoomState;
  isHost: boolean;
  clockMs: number;
  phase: string;
  micState: 'idle' | 'starting' | 'listening' | 'denied' | 'error';
  micLevel: number;
  captionsOn: boolean;
  onTogglePlay: () => void;
  /** Host only; guests see the pill disabled. */
  onSetPace: (pace: number) => void;
  onToggleCaptions: () => void;
  onToggleMic: () => void;
  onFullscreen: () => void;
  onLeave: () => void;
  /** Human-to-human audio (rooms): who is on voice, speaking, muted; host mute controls. */
  audio?: RoomAudioUi;
  selfId?: string;
  onMuteParticipant?: (participantId?: string) => void;
  onUnmuteVoice?: () => void;
}

export function BottomBar(p: BottomBarProps) {
  const total = p.state.plan?.segments.length ?? 0;
  const done = p.state.mode === 'complete' ? total : Math.min(total, p.state.segment);
  const playing = p.state.mode !== 'paused';
  const statusLabel =
    p.state.mode === 'listening'
      ? 'Paused — you have the floor'
      : p.state.mode === 'thinking'
        ? 'Thinking…'
        : p.state.mode === 'answering'
          ? 'Answering you'
          : p.state.mode === 'checking'
            ? 'Your turn to answer'
            : p.state.mode === 'complete'
              ? `Complete · step ${total} of ${total}`
              : p.state.mode === 'paused'
                ? `Paused · step ${Math.max(1, p.state.segment + 1)} of ${total}`
                : `Step ${Math.max(1, p.state.segment + 1)} of ${total}`;
  return (
    <div className="flex h-[54px] shrink-0 items-center gap-3 border-t border-line bg-surface px-3.5">
      <span
        className="grid size-[26px] place-items-center rounded-[8px] bg-accent-strong text-[13px] text-on-accent"
        aria-hidden
      >
        ◇
      </span>
      <div className="flex min-w-0 flex-auto items-center gap-2.5 border-l border-line-strong pl-2.5">
        <span className="min-w-0 truncate text-sm text-fg">
          {p.state.plan?.title ?? p.state.topic}
        </span>
        {p.state.phase === 'live' && p.state.mode !== 'complete' ? (
          <Pill tone="live" dot>
            Live session
          </Pill>
        ) : p.state.mode === 'complete' ? (
          <Pill tone="accent">Complete</Pill>
        ) : null}
        <span className="hidden text-xs text-fg-3 lg:inline">{statusLabel}</span>
      </div>
      {total > 0 ? <SegmentDots total={total} done={done} active={p.state.segment} /> : null}
      <span className="shrink-0 text-sm text-fg-2 tabular">{formatClock(p.clockMs)}</span>
      <ParticipantsControl
        state={p.state}
        isHost={p.isHost}
        selfId={p.selfId ?? ''}
        audio={p.audio ?? null}
        onMute={p.onMuteParticipant ?? null}
      />
      {p.isHost ? (
        <IconButton
          label={playing ? 'Pause' : 'Resume'}
          onClick={p.onTogglePlay}
          disabled={
            p.state.phase !== 'live' || p.state.mode === 'listening' || p.state.mode === 'answering'
          }
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </IconButton>
      ) : null}
      <PaceMenu
        value={p.state.pace}
        onChange={p.onSetPace}
        disabled={!p.isHost}
        disabledReason="Only the host sets the pace"
      />
      <IconButton
        label="Captions"
        state={p.captionsOn ? 'on' : 'default'}
        onClick={p.onToggleCaptions}
      >
        <Captions size={16} />
      </IconButton>
      <IconButton
        label={
          p.audio?.mutedByHost
            ? 'Muted by the host — unmute'
            : p.micState === 'listening'
              ? 'Mute microphone'
              : 'Unmute microphone'
        }
        state={
          p.audio?.mutedByHost
            ? 'warn'
            : p.micState === 'listening'
              ? 'on'
              : p.micState === 'denied'
                ? 'warn'
                : 'default'
        }
        onClick={p.audio?.mutedByHost && p.onUnmuteVoice ? p.onUnmuteVoice : p.onToggleMic}
        className="relative"
      >
        {p.micState === 'listening' && !p.audio?.mutedByHost ? (
          <Mic size={18} />
        ) : (
          <MicOff size={18} />
        )}
        {p.micState === 'listening' ? (
          <span
            aria-hidden
            className="absolute inset-0 rounded-[var(--radius-sm)] ring-2 ring-presence/60"
            style={{ opacity: Math.min(1, p.micLevel * 12) }}
          />
        ) : null}
      </IconButton>
      <IconButton label="Full screen" onClick={p.onFullscreen}>
        <Maximize2 size={15} />
      </IconButton>
      <Button variant="danger" size="sm" onClick={p.onLeave}>
        {p.isHost ? 'End' : 'Leave'}
      </Button>
    </div>
  );
}

// ── captions ──────────────────────────────────────────────────────────────────
export function CaptionOverlay({
  line,
  hint,
  on,
}: {
  line: CaptionLine | null;
  hint: string | null;
  on: boolean;
}) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!line) {
      setShown('');
      return;
    }
    if (line.who === 'learner' || line.revealMs <= 0) {
      setShown(line.text);
      return;
    }
    // Typewriter paced to the sentence's audio so the caption never leads the voice.
    const chars = line.text.length;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = performance.now() - start;
      const n = Math.min(chars, Math.ceil((t / Math.max(1, line.revealMs * 0.92)) * chars));
      setShown(line.text.slice(0, n));
      if (n < chars) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [line]);
  if (!on || !line)
    return hint ? (
      <div className="pointer-events-none absolute right-[126px] bottom-[22px] left-6 z-[5] text-center text-[12px] text-fg-2">
        {hint}
      </div>
    ) : null;
  return (
    <div className="pointer-events-none absolute right-[126px] bottom-[22px] left-6 z-[5]">
      <Caption
        speaker={line.speaker}
        text={shown || '…'}
        who={line.who}
        live={line.live}
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
}: {
  check: CheckEvent;
  question: string;
  onAnswer: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="absolute inset-x-0 bottom-[70px] z-[6] mx-auto w-[min(560px,90%)] animate-rise rounded-[var(--radius-lg)] bg-bg-elevated p-4 shadow-pop">
      <div className="mb-1 text-[10px] font-medium tracking-[0.1em] text-accent-strong uppercase">
        Quick check
      </div>
      <p className="mb-3 text-[15px] font-medium leading-snug text-fg text-pretty">{question}</p>
      {check.options.length > 0 ? (
        <div className="flex flex-col gap-2">
          {check.options.map((o) => (
            <Button
              key={o}
              variant="secondary"
              className="justify-start text-left"
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
          className="h-9 min-w-0 flex-1 rounded-[var(--radius-md)] bg-surface px-3 text-sm outline-none hairline focus:shadow-[0_0_0_2px_var(--color-accent)]"
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

// ── ad card (free plan) ───────────────────────────────────────────────────────
export function AdCard({
  durationMs,
  skippableAfterMs,
  startedAt,
  onSkip,
}: {
  durationMs: number;
  skippableAfterMs: number;
  startedAt: number;
  onSkip: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - startedAt;
  const canSkip = elapsed >= skippableAfterMs;
  const left = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
  return (
    <div className="absolute inset-0 z-[8] grid place-items-center bg-navy-900/70 backdrop-blur-[2px]">
      <div className="flex w-[min(520px,90%)] animate-rise flex-col gap-4 rounded-[var(--radius-xl)] bg-bg-elevated p-6 shadow-pop">
        <div className="flex items-center justify-between">
          <Pill tone="warm">Ad · supports free sessions</Pill>
          <span className="text-xs text-fg-3 tabular">{left}s</span>
        </div>
        <div className="grid h-[180px] place-items-center rounded-[var(--radius-lg)] bg-warm-soft text-center text-sm text-fg-2">
          Your ad could be here. Pen Playground stays free because of it.
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-3">Standard removes ads.</span>
          <Button variant={canSkip ? 'primary' : 'secondary'} disabled={!canSkip} onClick={onSkip}>
            {canSkip
              ? 'Skip ad'
              : `Skip in ${Math.max(1, Math.ceil((skippableAfterMs - elapsed) / 1000))}`}
          </Button>
        </div>
      </div>
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
  return (
    <div className="absolute inset-0 z-[7] flex justify-end bg-navy-900/70">
      <div className="h-full w-[min(430px,86%)] animate-rise overflow-auto bg-bg px-6 pt-6 pb-8 shadow-[-20px_0_50px_rgba(0,0,0,.5)]">
        <h6 className="mb-2 text-accent-strong">Session saved</h6>
        <h3 className="mb-1.5 leading-[1.14] tracking-[-0.02em] text-pretty">
          {state.plan?.title ?? state.topic}
        </h3>
        <p className="mb-[22px] text-sm text-fg-2">
          {expertFirstName} · {formatClock(state.clockMs)} · {questions.length} question
          {questions.length === 1 ? '' : 's'}
        </p>
        <h6 className="mb-2.5 text-fg-2">What {expertFirstName} covered</h6>
        <div className="mb-6 flex flex-col gap-2">
          {(state.recap ?? []).map((r) => (
            <div key={r} className="flex items-start gap-2.5">
              <span className="mt-2 size-[5px] shrink-0 rounded-full bg-accent" aria-hidden />
              <span className="text-sm leading-[1.5] text-fg-2">{r}</span>
            </div>
          ))}
        </div>
        <h6 className="mb-2.5 text-fg-2">Your questions</h6>
        <div className="mb-[26px] flex flex-col gap-3">
          {questions.length === 0 ? (
            <p className="text-[13.5px] text-fg-3">
              You didn't stop {expertFirstName} this time. Next one, jump in whenever.
            </p>
          ) : (
            questions.map((q) => (
              <div key={q.q} className="border-l-2 border-accent-strong pl-[11px]">
                <p className="mb-1 text-sm text-fg">{q.q}</p>
                <p className="text-[13px] leading-[1.5] text-fg-2">{q.a}</p>
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
    <div className="grid min-h-screen place-items-center bg-bg px-7 py-12">
      <div className="flex w-full max-w-[380px] flex-col items-center text-center">
        <div
          className={cn(
            'size-[92px] overflow-hidden rounded-full bg-surface-2 shadow-[0_0_0_3px_oklch(1_0_0/10%)] animate-ring',
          )}
        >
          {portraitUrl ? (
            <img src={portraitUrl} alt={expertName} className="size-full object-cover" />
          ) : (
            <Avatar name={expertName} size={92} />
          )}
        </div>
        <div className="mt-4 text-base font-medium text-fg">{expertName}</div>
        <div className="mt-0.5 text-[12.5px] text-fg-3">AI expert · {expertRole.toLowerCase()}</div>
        <div className="my-[26px] h-px w-11 bg-line-strong" />
        <div className="text-[19px] font-medium leading-[1.25] tracking-[-0.02em] text-fg text-pretty">
          {plan?.title ?? topic}
        </div>
        <div className="mt-[7px] text-[12.5px] text-fg-3">
          {plan
            ? `${plan.segments.length} steps · about ${Math.round(plan.seconds / 60)} minutes`
            : 'Getting the material together'}
        </div>
        <div className="mt-[34px] h-0.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full bg-accent transition-[width] duration-[var(--duration-scene)] ease-[var(--ease-out)]"
            style={{ width: `${Math.round((progress?.fraction ?? 0.05) * 100)}%` }}
          />
        </div>
        <div className="mt-3.5 flex items-center gap-2">
          <span className="block size-[13px] animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          <span className="text-sm text-fg-2">{progress?.status ?? 'Connecting…'}</span>
        </div>
      </div>
    </div>
  );
}
