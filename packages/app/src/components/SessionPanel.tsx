import type { Expert, RoomState } from '@pen/contracts';
import { CHAT_MAX_CHARS } from '@pen/contracts';
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
import { type ChatGroup, type ChatLine, groupChat } from '../room/chat.js';
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
export const CHAT_WINDOW = 80;

/**
 * The chat follows the newest line, unless the reader has scrolled up to see
 * something — then it stays exactly where they left it and catches up the
 * moment they come back to the bottom.
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
 * own so the learner can give the chat the whole column.
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
      {dot ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden /> : null}
      <h6 className="text-label-small font-semibold tracking-widest text-on-surface-dim uppercase">
        {label}
      </h6>
      {trailing}
      <span className="flex-1" />
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={controls}
        aria-label={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        onClick={onToggle}
        className="grid size-6 shrink-0 place-items-center rounded-full text-on-surface-variant transition-colors duration-[var(--duration-fast)] hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-primary"
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

// ── the chat, between the people in the room ──────────────────────────────────

/**
 * A run of lines from one person, under one name and one quiet timestamp.
 *
 * Deliberately not a wall of coloured bubbles: this column sits beside a board
 * that is the content, and it has to stay readable at 340 px without shouting.
 * Your own run is told apart by the rule down its leading edge and by being
 * named "You" — the brand's own red at low weight, which is an ordinary state
 * and wears no alarm colour (`CLAUDE.md`).
 */
function ChatRun({
  group,
  now,
  locale,
}: {
  group: ChatGroup;
  now: number;
  locale: string | undefined;
}) {
  return (
    <article
      data-testid={`chat-run-${group.id}`}
      data-participant={group.participantId}
      data-own={group.own ? 'true' : 'false'}
      className={cn(
        'rounded-md px-3 py-2',
        group.own
          ? 'border-s-2 border-primary-fixed/60 bg-surface-container-high/50'
          : 'bg-surface-container-high/70 hairline',
      )}
    >
      <p className="flex items-baseline gap-2">
        <span dir="auto" className="min-w-0 truncate text-label-large font-medium text-on-surface">
          {group.own ? 'You' : group.name}
        </span>
        <time
          dateTime={new Date(group.at).toISOString()}
          className="shrink-0 text-label-small text-on-surface-dim tabular-nums"
        >
          {formatElapsed(group.at, now, locale)}
        </time>
      </p>
      {group.lines.map((line) => (
        // `dir="auto"` per line: a Persian message in an English room reads in
        // its own direction, and an English one in a Persian room in its.
        <p
          key={line.id}
          dir="auto"
          className="mt-0.5 text-body-medium text-on-surface text-pretty break-words"
        >
          {line.text}
        </p>
      ))}
    </article>
  );
}

function Chat({
  id,
  lines,
  language,
  expertFirstName,
}: {
  id: string;
  lines: ChatLine[];
  language: string;
  expertFirstName: string;
}) {
  const now = useNow(15_000);
  const shown = lines.slice(-CHAT_WINDOW);
  const groups = groupChat(shown);
  const last = shown[shown.length - 1];
  const scroller = useStickToBottom(`${shown.length}:${last?.id ?? ''}`);
  return (
    <div
      id={id}
      ref={scroller}
      // A log rather than a bare live region: assistive technology reads new
      // lines in order and the reader can still walk back through them.
      role="log"
      aria-label="Chat with everyone in the room"
      // A scrolling region has to be reachable by keyboard, or the only way
      // back through it is a mouse: WCAG 2.1.1, and axe's
      // `scrollable-region-focusable` at *serious*, which is what
      // apps/web/e2e/ui-a11y.spec.ts fails the build on.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable log must be focusable; the lint rule's general case is not this one
      tabIndex={0}
      data-testid="chat"
      lang={language}
      dir={dirOf(language)}
      // Scrolls without an indicator, the way the reference column does.
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] focus-visible:outline-primary [&::-webkit-scrollbar]:hidden"
    >
      {groups.length === 0 ? (
        <p
          data-testid="chat-empty"
          className="m-auto max-w-[32ch] px-4 text-center text-body-small text-on-surface-dim text-pretty"
        >
          No messages yet. This is between the people in the room — {expertFirstName} doesn't see
          it. To ask {expertFirstName} something, just say it.
        </p>
      ) : (
        groups.map((group) => <ChatRun key={group.id} group={group} now={now} locale={language} />)
      )}
    </div>
  );
}

// ── the composer ──────────────────────────────────────────────────────────────

/**
 * What you type here reaches the other people in the room, and nothing else.
 * The expert never sees it and is never interrupted by it — which is why the
 * placeholder, the label and the button all say "message" and none of them
 * says "ask". Asking the expert is speaking, the way you interrupt a person.
 */
function Composer({
  language,
  disabled,
  note,
  onSend,
}: {
  language: string;
  disabled: boolean;
  note: string | null;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const noteId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || disabled) return;
    onSend(clean);
    setText('');
  };
  return (
    <form className="shrink-0 border-t border-outline-variant px-3 pt-2.5 pb-3" onSubmit={submit}>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-full bg-surface-container-high py-1 pe-1 ps-4 transition-[box-shadow,opacity] duration-[var(--duration-fast)] hairline',
          disabled ? 'opacity-60' : 'focus-within:shadow-[0_0_0_2px_var(--color-primary)]',
        )}
      >
        <input
          className="h-8 min-w-0 flex-1 bg-transparent text-body-medium text-on-surface outline-none placeholder:text-on-surface-dim disabled:cursor-not-allowed"
          placeholder={disabled ? 'Back in a moment…' : 'Message everyone'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Message everyone in the room"
          {...(note ? { 'aria-describedby': noteId } : {})}
          disabled={disabled}
          // The wire's own ceiling, so the field stops where the protocol does
          // rather than letting a long message come back as an error.
          maxLength={CHAT_MAX_CHARS}
          lang={language}
          // The learner writes in the lesson's language; what they type reads in its direction.
          dir={dirOf(language)}
          // Spellchecked in that language too — `lang` above is what tells the
          // browser which dictionary to use, so a Persian message is not
          // underlined as though it were bad English.
          spellCheck
          autoCorrect="on"
          autoCapitalize="sentences"
          data-testid="composer-input"
        />
        <button
          type="submit"
          // It sends a message to the room; it does not ask the expert
          // anything. The name a screen reader reads has to say so.
          aria-label="Send to everyone in the room"
          title="Send"
          disabled={disabled || text.trim() === ''}
          data-testid="composer-send"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-primary-fixed active:scale-[0.96] focus-visible:outline-primary disabled:bg-surface-container-low disabled:text-on-surface-dim disabled:active:scale-100"
        >
          <ArrowUp size={16} aria-hidden />
        </button>
      </div>
      {note ? (
        <p
          id={noteId}
          className="mt-1.5 px-1 text-label-small text-on-surface-dim"
          data-testid="composer-note"
        >
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
  /** What the people in the room have said to each other. The expert is not in it. */
  chat: ChatLine[];
  /** Reactions still on screen; they float over the participant cards. */
  reactions: LiveReaction[];
  /** An ad holds the floor: the composer is off for its duration, calmly. */
  adPaused: boolean;
  /** Say something to the other people in the room. Never reaches the expert. */
  onSend: (text: string) => void;
}

function PanelBody(p: SessionPanelProps & { bodyId: string }) {
  const [rosterOpen, setRosterOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const logId = useId();
  const firstName = p.expert?.displayName.split(' ')[0] ?? 'Expert';
  const note = p.adPaused
    ? 'Voice and typing are back the moment the ad ends.'
    : p.micState === 'denied'
      ? // Honest about what is actually lost: the microphone is how you reach
        // the expert, and this box is not a way round that.
        `The microphone is off in your browser settings — ${firstName} can't hear you until it is back on.`
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
        label="Chat"
        dot
        open={chatOpen}
        onToggle={() => setChatOpen((v) => !v)}
        controls={logId}
        testId="chat-section-toggle"
      />
      {chatOpen ? (
        <Chat id={logId} lines={p.chat} language={p.state.language} expertFirstName={firstName} />
      ) : (
        <div className="flex-1" />
      )}

      <Composer language={p.state.language} disabled={p.adPaused} note={note} onSend={p.onSend} />
    </div>
  );
}

/**
 * The session panel: the AI human and everyone else on the call, the chat
 * between the people in the room, and the box that writes into it.
 *
 * The expert is on the call and not in the chat. Nothing the expert says is
 * written here — a real expert does not keep a running transcript of
 * themselves beside the board — and nothing written here reaches them. What
 * they said is available to whoever wants it, as captions, from the CC
 * control in the bottom bar.
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
        className="grid h-16 w-6 place-items-center rounded-full bg-surface-container-high text-on-surface-variant transition-colors duration-[var(--duration-fast)] hairline hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-primary"
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
        'flex h-full shrink-0 border-s border-outline-variant bg-surface outline-none',
        'transition-[width] duration-[var(--duration-slow)] ease-[var(--ease-out)]',
        drawer
          ? 'w-full max-w-[min(420px,92%)] shadow-level3'
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
        className="absolute inset-0 cursor-default bg-scrim/45 [animation:rise_var(--duration-base)_var(--ease-out)_both]"
      />
      <div className="relative animate-rise">{surface}</div>
    </div>
  );
}
