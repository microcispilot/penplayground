import {
  BOARD_SURFACES,
  type BoardSurface,
  type BoardTool,
  defaultToolFor,
  INKS,
  type Ink,
  inkUsableOn,
  planAllowsInk,
  planAllowsSurface,
  planAllowsTool,
  planNameFor,
  TOOLS,
} from '@pen/contracts';
import { cn } from '@pen/design';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ShellPage } from '../components/AppShell.js';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useSeo } from '../lib/seo.js';
import { isDarkTheme, useTheme } from '../lib/theme.js';
import { useBoard } from '../lib/use-board.js';
import { CHALK_HANDWRITING, MARKER_HANDWRITING } from './board-handwriting.js';

/**
 * Settings: the things that are about the app rather than about a lesson.
 *
 * It is the first screen of its kind here — the theme lived as a lone icon in
 * the header and nothing else had a home — so it is built as *sections* rather
 * than as a board picker, because the owner asked for exactly that: *"in
 * settings we should have different parts like board backgrounds, etc."* The
 * next preference goes in as another `<Section>` and nothing else moves.
 *
 * ── how gating reads here ──────────────────────────────────────────────────
 *
 * Two different kinds of "you cannot have this", and they are deliberately not
 * drawn the same way:
 *
 *   **The board's own colour** — white on the whiteboard, black on the
 *   blackboard — is *disabled*, with the reason under it. It is the one ink
 *   that can never be written on that surface (ADR-0041), it is the same dot
 *   in the same place on every board, and the owner asked for exactly this:
 *   *"they should just get disabled."* Nothing else about the writing is
 *   tied to the board: chalk goes on the whiteboard and a marker on slate.
 *
 *   **Above your plan** is *shown*, with the plan's name beside it, and it
 *   goes to Pricing when chosen. Never a padlock, never a disabled control the
 *   learner can hover and get nothing from: the house rule is that a limit is
 *   a friendly sentence with a link, and a plan tag is the calmest form of it.
 *   This is the same treatment `ExpertCard` gives a legend you have not paid
 *   for, and the sidebar gives Downloads and Rooms.
 */
function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section className="border-outline-variant border-t py-8 first:border-t-0 first:pt-0">
      <h3 className="text-title-medium">{title}</h3>
      <p className="mt-1.5 max-w-[560px] text-body-medium text-on-surface-variant text-pretty">
        {intro}
      </p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** "Standard" beside a row the learner has not paid for. Never a warning. */
function PlanTag({ name }: { name: string }) {
  return (
    <span className="shrink-0 rounded-full bg-surface-container-highest px-1.5 py-px text-label-tiny font-normal text-on-surface-variant">
      {name}
    </span>
  );
}

/**
 * A board, drawn as itself, with something written on it.
 *
 * The swatch wears `data-board`, so every colour in it — the surface, the
 * frame, the ink of the writing — comes from the same token block that
 * paints the real board. There is not one hex in this file, which is what
 * makes a palette change in `tokens.css` show up here for free.
 *
 * The writing is a real piece of board work (Pythagoras, a triangle, one
 * worked line) rather than a bar: a preview of a board should look like a
 * lesson on it. It is an alpha mask (`board-handwriting.ts`, drawn once in
 * chalk and once in marker) laid over the surface and filled with
 * `--color-ink`, so the same drawing appears in white chalk on slate, in
 * black marker on cream, and in whichever tool and colour the learner picks
 * below. A board's own preview is written with the tool in use, so choosing
 * chalk re-writes every swatch in chalk.
 */
function Handwriting({ tool, className }: { tool: BoardTool; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-[7%] inset-y-[10%] bg-[var(--color-ink)]',
        className,
      )}
      style={{
        maskImage: `url("${tool === 'chalk' ? CHALK_HANDWRITING : MARKER_HANDWRITING}")`,
        WebkitMaskImage: `url("${tool === 'chalk' ? CHALK_HANDWRITING : MARKER_HANDWRITING}")`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  );
}

function SurfaceCard({
  surface,
  tool,
  chosen,
  locked,
  onChoose,
}: {
  surface: BoardSurface;
  /** The tool the writing on the preview is in: the one in use, or the board's own. */
  tool: BoardTool | null;
  chosen: boolean;
  locked: string | null;
  onChoose: () => void;
}) {
  const body = (
    <>
      {surface.id === 'auto' ? (
        // `auto` has no board of its own to preview, so it shows the two it
        // stands for, split down the middle — each half a real board with the
        // same writing in its own ink, clipped along the diagonal.
        <span className="relative block h-[112px] overflow-hidden rounded-md border-4 border-outline-variant">
          <span
            data-board="whiteboard"
            className="absolute inset-0 bg-[var(--color-paper)] [clip-path:polygon(0_0,58%_0,42%_100%,0_100%)]"
          >
            <Handwriting tool={tool ?? 'marker'} />
          </span>
          <span
            data-board="blackboard"
            className="absolute inset-0 bg-[var(--color-paper)] [clip-path:polygon(58%_0,100%_0,100%_100%,42%_100%)]"
          >
            <Handwriting tool={tool ?? 'chalk'} />
          </span>
        </span>
      ) : (
        <span
          data-board={surface.id}
          className="relative block h-[112px] overflow-hidden rounded-md border-4 border-[var(--board-frame-b)] bg-[var(--color-paper)]"
        >
          <Handwriting tool={tool ?? defaultToolFor(surface)} />
        </span>
      )}
      <span className="mt-2.5 flex items-start gap-2">
        {/* Wraps rather than truncates: "Green board" beside its plan tag does not fit a phone's column, and "Green boa…" is not a name. */}
        <span className="min-w-0 flex-1 text-label-large font-semibold leading-tight text-balance">
          {surface.name}
        </span>
        {chosen ? (
          <Check size={15} className="shrink-0 text-on-secondary-container" aria-hidden />
        ) : null}
        {locked ? <PlanTag name={locked} /> : null}
      </span>
      {/* On the brand fill every line is white: a note in `on-surface-variant` vanished into it. */}
      <span
        className={cn(
          'mt-0.5 block text-body-small',
          chosen ? 'text-on-secondary-container' : 'text-on-surface-variant',
        )}
      >
        {surface.note}
      </span>
    </>
  );

  const shell = cn(
    'state-layer group rounded-lg p-2 text-left transition-colors',
    chosen && 'bg-secondary-container text-on-secondary-container',
  );

  // A board above the plan is a link to Pricing, not a dead control: the
  // learner gets somewhere from clicking it.
  return locked ? (
    <Link
      to="/pricing"
      className={shell}
      data-testid={`board-${surface.id}`}
      onClick={() => trackAction('upgrade_clicked', { source: 'settings_board' })}
    >
      {body}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onChoose}
      className={shell}
      aria-pressed={chosen}
      data-testid={`board-${surface.id}`}
    >
      {body}
    </button>
  );
}

/**
 * The two tools, each drawn as itself on the board in use. "Follow the board"
 * is the default and what a free learner has: marker on a light board, chalk
 * on a dark one.
 */
function ToolCard({
  id,
  name,
  note,
  surfaceId,
  tool,
  chosen,
  locked,
  onChoose,
}: {
  id: 'auto' | BoardTool;
  name: string;
  note: string;
  surfaceId: string;
  tool: BoardTool;
  chosen: boolean;
  locked: string | null;
  onChoose: () => void;
}) {
  const body = (
    <>
      <span
        data-board={surfaceId}
        className="relative block h-[72px] overflow-hidden rounded-md border-4 border-[var(--board-frame-b)] bg-[var(--color-paper)]"
      >
        <Handwriting tool={tool} />
      </span>
      {/* Wraps rather than squeezes: on a phone's third of a column "Marker"
          beside its plan tag is "Mark", so the tag drops under the name instead. */}
      <span className="mt-2.5 flex flex-wrap items-start gap-x-2 gap-y-1">
        <span className="flex-1 text-label-large font-semibold leading-tight">{name}</span>
        {chosen ? (
          <Check size={15} className="shrink-0 text-on-secondary-container" aria-hidden />
        ) : null}
        {locked ? <PlanTag name={locked} /> : null}
      </span>
      <span
        className={cn(
          'mt-0.5 block text-body-small',
          chosen ? 'text-on-secondary-container' : 'text-on-surface-variant',
        )}
      >
        {note}
      </span>
    </>
  );
  const shell = cn(
    'state-layer group rounded-lg p-2 text-left transition-colors',
    chosen && 'bg-secondary-container text-on-secondary-container',
  );
  return locked ? (
    <Link
      to="/pricing"
      className={shell}
      data-testid={`tool-${id}`}
      onClick={() => trackAction('upgrade_clicked', { source: 'settings_tool' })}
    >
      {body}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onChoose}
      className={shell}
      aria-pressed={chosen}
      data-testid={`tool-${id}`}
    >
      {body}
    </button>
  );
}

/**
 * One colour, drawn in itself on the board in use.
 *
 * Three states, and they are not drawn alike. Chosen and choosable are a
 * button. Above the plan is a link to Pricing with the plan's name under it.
 * The board's own colour is a disabled button with "the board's colour" under
 * it: not a limit, not a lock — a fact about paint.
 */
function InkDot({
  ink,
  surfaceId,
  chosen,
  locked,
  unusable,
  onChoose,
}: {
  ink: Ink;
  surfaceId: string;
  chosen: boolean;
  locked: string | null;
  /** True when this is the surface's own colour and cannot be written on it. */
  unusable: boolean;
  onChoose: () => void;
}) {
  const body = (
    <>
      <span
        data-board={surfaceId}
        data-ink={ink.id}
        aria-hidden
        className={cn(
          'block size-7 rounded-full border-2 bg-[var(--color-ink)]',
          // The choice is the card's fill, as it is for a board; the dot keeps a quiet edge.
          chosen ? 'border-on-secondary-container/40' : 'border-outline-variant',
          unusable && 'opacity-disabled',
        )}
      />
      <span
        className={cn(
          'mt-1.5 flex items-center justify-center gap-1 text-label-small font-semibold',
          unusable && 'text-on-surface-variant',
        )}
      >
        {ink.name}
        {chosen ? (
          <Check size={13} className="shrink-0 text-on-secondary-container" aria-hidden />
        ) : null}
      </span>
      <span
        className={cn(
          'block max-w-[64px] min-h-[1em] text-label-tiny text-balance',
          chosen ? 'text-on-secondary-container' : 'text-on-surface-variant',
        )}
      >
        {unusable ? 'The board’s colour' : (locked ?? '')}
      </span>
    </>
  );
  // Three rows on a fixed grid — dot, name, plan — so a colour without a plan
  // tag keeps its dot on the same line as the others rather than dropping to
  // sit on the baseline. `grid-rows-subgrid` takes the rows from the fieldset.
  // Chosen is drawn the way a chosen board is (the owner, 2026-09-25: "the
  // selected options should be properly shown selected, not with just a
  // border around the colour; the same as the board selections"): the
  // secondary-container fill with a check, never only a ring on the dot.
  const shell = cn(
    'state-layer grid grid-rows-subgrid row-span-3 justify-items-center rounded-lg px-1.5 pt-1.5 pb-1 text-center transition-colors',
    chosen && 'bg-secondary-container text-on-secondary-container',
  );
  if (unusable) {
    return (
      <button
        type="button"
        className={cn(shell, 'cursor-not-allowed')}
        disabled
        aria-disabled
        title={`${ink.name} is the board’s own colour`}
        data-testid={`ink-${ink.id}`}
      >
        {body}
      </button>
    );
  }
  return locked ? (
    <Link
      to="/pricing"
      className={shell}
      data-testid={`ink-${ink.id}`}
      onClick={() => trackAction('upgrade_clicked', { source: 'settings_ink' })}
    >
      {body}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onChoose}
      className={shell}
      aria-pressed={chosen}
      data-testid={`ink-${ink.id}`}
    >
      {body}
    </button>
  );
}

export function Settings() {
  useSeo({ title: 'Settings', description: 'The board you learn on, and how Pen looks.' });
  const { participant, setCheckIns } = useApp();
  const [theme, setTheme] = useTheme();
  const { preference, surface, ink, tool, choose } = useBoard();
  const plan = participant?.plan ?? 'free';

  return (
    <ShellPage title="Settings" intro="The board you learn on, and how Pen looks.">
      <div className="max-w-[720px]">
        <Section
          title="Board"
          intro="The surface every lesson is taught on. Follow the theme for a whiteboard by day and a blackboard at night, or pin one."
        >
          {/*
            A real <fieldset>, not a div with role="group": the grouping is
            what a screen reader announces before the first swatch, and the
            legend is the only thing saying these six are one choice.
          */}
          <fieldset className="grid grid-cols-2 gap-2 border-0 p-0 sm:grid-cols-3">
            <legend className="sr-only">Board surface</legend>
            {BOARD_SURFACES.map((s) => (
              <SurfaceCard
                key={s.id}
                surface={s}
                // The writing on every preview is in the tool in use, unless
                // the learner has left it to the board — then each board
                // shows its own.
                tool={preference.tool === 'auto' ? null : tool}
                chosen={preference.surface === s.id}
                locked={planAllowsSurface(plan, s.id) ? null : planNameFor(s.minPlan)}
                onChoose={() => {
                  trackAction('board_chosen', { surface: s.id });
                  choose({ ...preference, surface: s.id });
                }}
              />
            ))}
          </fieldset>
        </Section>

        <Section
          title="Writing"
          intro="Chalk or marker, on any board. Follow the board for a marker on a light surface and chalk on a dark one."
        >
          <fieldset className="grid grid-cols-3 gap-2 border-0 p-0">
            <legend className="sr-only">Writing tool</legend>
            <ToolCard
              id="auto"
              name="Follow the board"
              note={surface.dark ? 'Chalk, on this board.' : 'Marker, on this board.'}
              surfaceId={surface.id}
              tool={defaultToolFor(surface)}
              chosen={preference.tool === 'auto'}
              locked={null}
              onChoose={() => {
                trackAction('tool_chosen', { tool: 'auto', surface: surface.id });
                choose({ ...preference, tool: 'auto' });
              }}
            />
            {TOOLS.map((t) => (
              <ToolCard
                key={t.id}
                id={t.id}
                name={t.name}
                note={t.id === 'chalk' ? 'Dusty, soft-edged writing.' : 'Solid, even lines.'}
                surfaceId={surface.id}
                tool={t.id}
                chosen={preference.tool === t.id}
                locked={planAllowsTool(plan, t.id) ? null : planNameFor(t.minPlan)}
                onChoose={() => {
                  trackAction('tool_chosen', { tool: t.id, surface: surface.id });
                  choose({ ...preference, tool: t.id });
                }}
              />
            ))}
          </fieldset>
        </Section>

        <Section
          title="Colour"
          intro="What the expert writes in. Every colour goes on every board, except the board’s own."
        >
          {/*
            One line, at every width. Seven colours no longer fit a phone's
            column, and the owner's rule is that the dots share a line — so
            the row is a column-flow grid that scrolls sideways rather than
            one that wraps. The three rows (dot, name, note) stay a subgrid so
            a dot with a note under it keeps its dot level with the others.
          */}
          <fieldset className="-mx-1 grid grid-flow-col auto-cols-[minmax(64px,max-content)] grid-rows-[auto_auto_auto] items-start gap-x-0.5 overflow-x-auto border-0 px-1 pt-0 pb-1">
            <legend className="sr-only">Ink colour</legend>
            {INKS.map((c) => (
              <InkDot
                key={c.id}
                ink={c}
                surfaceId={surface.id}
                chosen={ink === c.id}
                locked={planAllowsInk(plan, c.id) ? null : planNameFor(c.minPlan)}
                unusable={!inkUsableOn(surface, c.id)}
                onChoose={() => {
                  trackAction('ink_chosen', { ink: c.id, surface: surface.id });
                  choose({ ...preference, ink: c.id });
                }}
              />
            ))}
          </fieldset>
        </Section>

        {participant && !participant.anonymous ? (
          <Section
            title="Quick checks"
            intro="Now and then the expert stops, asks one question and waits for your answer before going on. Turn it off and the lesson runs straight through."
          >
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md bg-surface-container-low px-4 py-3">
              <span className="text-body-medium text-on-surface">Stop for quick checks</span>
              <input
                type="checkbox"
                role="switch"
                className="size-5 accent-primary"
                checked={participant.checkIns}
                onChange={(e) => void setCheckIns(e.target.checked).catch(() => undefined)}
                aria-checked={participant.checkIns}
                data-testid="check-ins-toggle"
              />
            </label>
            <p className="mt-2 text-body-small text-on-surface-variant">
              Takes effect from your next session.
            </p>
          </Section>
        ) : null}

        <Section
          title="Theme"
          intro="How the rest of Pen looks. The board follows it only when it is set to follow the theme."
        >
          <fieldset className="flex flex-wrap gap-1 border-0 p-0">
            <legend className="sr-only">Theme</legend>
            {(['light', 'dark'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  trackAction('theme_changed', { theme: t, source: 'settings' });
                  setTheme(t);
                }}
                aria-pressed={isDarkTheme(theme) === (t === 'dark')}
                data-testid={`theme-${t}`}
                className={cn(
                  'state-layer rounded-full px-4 py-1.5 text-label-large font-semibold transition-colors',
                  isDarkTheme(theme) === (t === 'dark')
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface-variant',
                )}
              >
                {t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </fieldset>
        </Section>
      </div>
    </ShellPage>
  );
}
