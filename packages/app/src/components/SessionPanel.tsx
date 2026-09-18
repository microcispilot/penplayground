import type { Expert, RoomState } from '@pen/contracts';
import { cn, type ExpertPresence, useModalFocus } from '@pen/design';
import { ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { dirOf, formatElapsed } from '../lib/locale.js';
import {
  readSessionPanelPreference,
  writeSessionPanelPreference,
} from '../lib/session-panel-preference.js';
import { useNow } from '../lib/use-now.js';
import type { KeyValueStorage } from '../platform/types.js';
import type { RoomAudioUi } from '../room/audio/RoomAudio.js';
import type { ConversationMessage } from '../room/conversation.js';
import type { LiveReaction } from '../room/reactions.js';
import { ParticipantRoster } from './Participants.js';

/**
 * Whether the panel is docked open, remembered across visits the way the
 * shell's own sidebar is (ADR-0015). The room owns the drawer on a narrow
 * screen, which is deliberately *not* remembered: a panel that opens over the
 * board the instant a lesson starts is not what "open" meant.
 */
export function useSessionPanel(storage: KeyValueStorage): {
  open: boolean;
  toggle: () => void;
} {
  const [open, setOpen] = useState(() => readSessionPanelPreference(storage) === 'open');
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      writeSessionPanelPreference(storage, next ? 'open' : 'collapsed');
      return next;
    });
  }, [storage]);
  return { open, toggle };
}

/** The strip that stays behind when the panel is collapsed: only its control. */
export const SESSION_PANEL_RAIL = 34;
/** How many lines are drawn at once; the store keeps more than the eye scrolls back to. */
export const CONVERSATION_WINDOW = 80;

/**
 * The conversation follows the newest line, unless the learner has scrolled up
 * to read something — then it stays exactly where they left it and catches up
 * the moment they come back to the bottom.
 */
function useStickToBottom(dep: unknown): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dependency is the event (a new or growing line), not a value read here
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

// ── sections ──────────────────────────────────────────────────────────────────

/**
 * A section of the panel with its own heading and its own chevron, the way the
 * reference view groups the call and the activity: each one folds away on its
 * own so the learner can give the conversation the whole column.
 */
function SectionHeader({
  label,
  dot,
  open,
  onToggle,
  controls,
  trailing,
  testId,
}: {
  label: string;
  dot?: boolean;
  open: boolean;
  onToggle: () => void;
  controls: string;
  trailing?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-2">
      {dot ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden /> : null}
      <h2 className="text-[10.5px] font-semibold tracking-[0.1em] text-fg-3 uppercase">{label}</h2>
      {trailing}
      <span className="flex-1" />
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={controls}
        aria-label={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        onClick={onToggle}
        className="grid size-6 shrink-0 place-items-center rounded-full text-fg-2 transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-fg focus-visible:outline-accent"
      >
        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            'transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)]',
            !open && '-rotate-90 rtl:rotate-90',
          )}
        />
      </button>
    </div>
  );
}

// ── the conversation ──────────────────────────────────────────────────────────

function Line({
  m,
  now,
  locale,
}: {
  m: ConversationMessage;
  now: number;
  locale: string | undefined;
}) {
  if (m.role === 'system')
    return (
      <article
        data-role="system"
        data-kind={m.kind}
        className="px-2 py-1 text-center text-[11.5px] leading-[1.5] text-fg-3"
      >
        {m.text}
      </article>
    );
  return (
    <article
      data-role={m.role}
      data-kind={m.kind}
      {...(m.live ? { 'data-live': 'true' } : {})}
      className={cn(
        'rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-[var(--duration-fast)]',
        m.live
          ? 'border border-dashed border-accent/45 bg-accent-soft/35'
          : 'bg-surface-2/70 hairline',
      )}
    >
      <p className="text-[13.5px] leading-[1.5] text-fg text-pretty">
        <span
          dir="auto"
          className={cn(
            'font-medium',
            m.role === 'expert' ? 'text-accent-strong' : 'text-presence',
          )}
        >
          {m.speaker}
        </span>{' '}
        <span className={cn(m.live && 'text-fg-2 italic')}>
          {m.text}
          {m.live ? '…' : ''}
        </span>
      </p>
      <p className="mt-1 text-[11px] text-fg-3">{formatElapsed(m.at, now, locale)}</p>
    </article>
  );
}

function Conversation({
  id,
  messages,
  language,
  expertFirstName,
}: {
  id: string;
  messages: ConversationMessage[];
  language: string;
  expertFirstName: string;
}) {
  const now = useNow(15_000);
  const shown = messages.slice(-CONVERSATION_WINDOW);
  const last = shown[shown.length - 1];
  const scroller = useStickToBottom(`${shown.length}:${last?.text.length ?? 0}`);
  return (
    <div
      id={id}
      ref={scroller}
      // A log rather than a bare live region: assistive technology reads new
      // lines in order and the learner can still walk back through them.
      role="log"
      aria-label={`Conversation with ${expertFirstName}`}
      data-testid="conversation"
      lang={language}
      dir={dirOf(language)}
      // Scrolls without an indicator, the way the reference conversation does.
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {shown.length === 0 ? (
        <p className="m-auto max-w-[30ch] px-4 text-center text-[12.5px] leading-[1.55] text-fg-3">
          Nothing here yet. {expertFirstName} starts in a moment — jump in whenever, out loud or
          here.
        </p>
      ) : (
        shown.map((m) => <Line key={m.id} m={m} now={now} locale={language} />)
      )}
    </div>
  );
}

// ── the composer ──────────────────────────────────────────────────────────────

function Composer({
  expertFirstName,
  language,
  disabled,
  note,
  onAsk,
}: {
  expertFirstName: string;
  language: string;
  disabled: boolean;
  note: string | null;
  onAsk: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const noteId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || disabled) return;
    onAsk(clean);
    setText('');
  };
  return (
    <form className="shrink-0 border-t border-line px-3 pt-2.5 pb-3" onSubmit={submit}>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pe-1 ps-4 transition-[box-shadow,opacity] duration-[var(--duration-fast)] hairline',
          disabled ? 'opacity-60' : 'focus-within:shadow-[0_0_0_2px_var(--color-accent)]',
        )}
      >
        <input
          className="h-8 min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-3 disabled:cursor-not-allowed"
          placeholder={disabled ? 'Back in a moment…' : `Ask ${expertFirstName} — or just talk`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Ask a question"
          {...(note ? { 'aria-describedby': noteId } : {})}
          disabled={disabled}
          maxLength={4000}
          lang={language}
          // The learner writes in the lesson's language; what they type reads in its direction.
          dir={dirOf(language)}
          data-testid="composer-input"
        />
        <button
          type="submit"
          aria-label={`Send to ${expertFirstName}`}
          title="Send"
          disabled={disabled || text.trim() === ''}
          data-testid="composer-send"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-strong text-on-accent transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-accent-pressed active:scale-[0.96] focus-visible:outline-accent disabled:bg-surface disabled:text-fg-3 disabled:active:scale-100"
        >
          <ArrowUp size={16} aria-hidden />
        </button>
      </div>
      {note ? (
        <p id={noteId} className="mt-1.5 px-1 text-[11.5px] text-fg-3" data-testid="composer-note">
          {note}
        </p>
      ) : null}
    </form>
  );
}

// ── the panel ─────────────────────────────────────────────────────────────────

export interface SessionPanelProps {
  /** Docked beside the board on a wide screen; a drawer over it on a narrow one. */
  mode: 'docked' | 'drawer';
  open: boolean;
  onToggle: () => void;
  state: RoomState;
  expert: Expert | null;
  expertPresence: ExpertPresence;
  expertPortraitUrl: string | null;
  soundBlocked: boolean;
  onEnableSound: () => void;
  isHost: boolean;
  selfId: string;
  audio: RoomAudioUi | null;
  micState: 'idle' | 'starting' | 'listening' | 'denied' | 'error';
  micLevel: number;
  onToggleMic: () => void;
  onMute: ((participantId?: string) => void) | null;
  conversation: ConversationMessage[];
  /** Reactions still on screen; they float over the participant cards. */
  reactions: LiveReaction[];
  /** An ad holds the floor: the composer is off for its duration, calmly. */
  adPaused: boolean;
  onAsk: (text: string) => void;
}

function PanelBody(p: SessionPanelProps & { bodyId: string }) {
  const [rosterOpen, setRosterOpen] = useState(true);
  const [conversationOpen, setConversationOpen] = useState(true);
  const logId = useId();
  const firstName = p.expert?.displayName.split(' ')[0] ?? 'Expert';
  const note = p.adPaused
    ? 'Voice and typing are back the moment the ad ends.'
    : p.micState === 'denied'
      ? 'The microphone is off in your browser settings — typing still works.'
      : null;
  return (
    <div id={p.bodyId} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ParticipantRoster
        state={p.state}
        expert={p.expert}
        expertPresence={p.expertPresence}
        expertPortraitUrl={p.expertPortraitUrl}
        soundBlocked={p.soundBlocked}
        onEnableSound={p.onEnableSound}
        isHost={p.isHost}
        selfId={p.selfId}
        audio={p.audio}
        micState={p.micState}
        micLevel={p.micLevel}
        onToggleMic={p.onToggleMic}
        onMute={p.onMute}
        reactions={p.reactions}
        sectionOpen={rosterOpen}
        onToggleSection={() => setRosterOpen((v) => !v)}
      />

      <SectionHeader
        label="Conversation"
        dot
        open={conversationOpen}
        onToggle={() => setConversationOpen((v) => !v)}
        controls={logId}
        testId="conversation-section-toggle"
      />
      {conversationOpen ? (
        <Conversation
          id={logId}
          messages={p.conversation}
          language={p.state.language}
          expertFirstName={firstName}
        />
      ) : (
        <div className="flex-1" />
      )}

      <Composer
        expertFirstName={firstName}
        language={p.state.language}
        disabled={p.adPaused}
        note={note}
        onAsk={p.onAsk}
      />
    </div>
  );
}

/**
 * The session panel: the AI human and everyone else on the call, the
 * conversation, and the composer — the pieces that used to be a floating orb,
 * a caption strip over the board and a question row under it.
 *
 * The control that folds it away sits on the panel's own left edge and is all
 * that is left when it is closed: a chevron pointing right while the panel is
 * open (the way it will move) and left once it has gone (the way it comes
 * back). The choice is remembered.
 */
export function SessionPanel(p: SessionPanelProps) {
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const drawer = p.mode === 'drawer';
  const close = p.onToggle;
  useModalFocus(drawer && p.open, close, panelRef);

  if (drawer && !p.open) return null;

  const handle = (
    // No seam of its own: the panel is one surface, and the chevron floats on its edge.
    <div
      className="flex shrink-0 items-center justify-center"
      style={{ width: SESSION_PANEL_RAIL }}
    >
      <button
        type="button"
        data-testid="session-panel-toggle"
        aria-expanded={p.open}
        aria-controls={bodyId}
        aria-label={p.open ? 'Hide the session panel' : 'Show the session panel'}
        title={p.open ? 'Hide the session panel' : 'Show the session panel'}
        onClick={p.onToggle}
        className="grid h-16 w-6 place-items-center rounded-full bg-surface-2 text-fg-2 transition-colors duration-[var(--duration-fast)] hairline hover:bg-surface hover:text-fg focus-visible:outline-accent"
      >
        <ChevronRight
          size={16}
          aria-hidden
          className={cn(
            'transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)]',
            !p.open && 'rotate-180',
          )}
        />
      </button>
    </div>
  );

  const surface = (
    <aside
      ref={panelRef}
      data-testid="session-panel"
      data-open={p.open ? 'true' : 'false'}
      data-mode={p.mode}
      aria-label="Session panel"
      {...(drawer ? { role: 'dialog' as const, 'aria-modal': true, tabIndex: -1 } : {})}
      className={cn(
        'flex h-full shrink-0 border-s border-line bg-bg outline-none',
        'transition-[width] duration-[var(--duration-slow)] ease-[var(--ease-out)]',
        drawer
          ? 'w-full max-w-[min(420px,92%)] shadow-pop'
          : p.open
            ? // A small laptop gives the board back the 50 px a wide screen can spare.
              'w-[340px] xl:w-[390px]'
            : 'w-[34px]',
      )}
    >
      {handle}
      {p.open ? <PanelBody {...p} bodyId={bodyId} /> : null}
    </aside>
  );

  if (!drawer) return surface;
  return (
    <div className="absolute inset-0 z-[12] flex justify-end" data-testid="session-panel-drawer">
      <button
        type="button"
        aria-label="Close the session panel"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 cursor-default bg-navy-900/45 [animation:rise_var(--duration-base)_var(--ease-out)_both]"
      />
      <div className="relative animate-rise">{surface}</div>
    </div>
  );
}
