import {
  BOARD_SURFACES,
  type BoardSurface,
  type Ink,
  type InkId,
  inksFor,
  planAllowsInk,
  planAllowsSurface,
  planNameFor,
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
 *   **Wrong kind** — chalk while a whiteboard is selected — is *filtered out*.
 *   A chalk cannot go on a marker board, so offering it greyed would be
 *   offering a thing that is never available; the colours simply change when
 *   the board does.
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
 * black marker on cream, and in whichever colour the learner picks below.
 */
function Handwriting({ kind, className }: { kind: 'chalk' | 'marker'; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-[7%] inset-y-[10%] bg-[var(--color-ink)]',
        className,
      )}
      style={{
        maskImage: `url("${kind === 'chalk' ? CHALK_HANDWRITING : MARKER_HANDWRITING}")`,
        WebkitMaskImage: `url("${kind === 'chalk' ? CHALK_HANDWRITING : MARKER_HANDWRITING}")`,
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
  chosen,
  locked,
  onChoose,
}: {
  surface: BoardSurface;
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
            <Handwriting kind="marker" />
          </span>
          <span
            data-board="blackboard"
            className="absolute inset-0 bg-[var(--color-paper)] [clip-path:polygon(58%_0,100%_0,100%_100%,42%_100%)]"
          >
            <Handwriting kind="chalk" />
          </span>
        </span>
      ) : (
        <span
          data-board={surface.id}
          className="relative block h-[112px] overflow-hidden rounded-md border-4 border-[var(--board-frame-b)] bg-[var(--color-paper)]"
        >
          <Handwriting kind={surface.kind ?? 'marker'} />
        </span>
      )}
      <span className="mt-2.5 flex items-start gap-2">
        {/* Wraps rather than truncates: "Green board" beside its plan tag does not fit a phone's column, and "Green boa…" is not a name. */}
        <span className="min-w-0 flex-1 text-label-large font-semibold leading-tight text-balance">
          {surface.name}
        </span>
        {chosen ? <Check size={15} className="shrink-0 text-primary" aria-hidden /> : null}
        {locked ? <PlanTag name={locked} /> : null}
      </span>
      <span className="mt-0.5 block text-body-small text-on-surface-variant">{surface.note}</span>
    </>
  );

  const shell = cn(
    'state-layer group rounded-lg p-2 text-left transition-colors',
    chosen && 'bg-secondary-container',
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

/** One colour, drawn in itself on the board it belongs to. */
function InkDot({
  ink,
  surfaceId,
  chosen,
  locked,
  onChoose,
}: {
  ink: Ink;
  surfaceId: string;
  chosen: boolean;
  locked: string | null;
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
          chosen ? 'border-primary' : 'border-outline-variant',
        )}
      />
      <span className="mt-1.5 flex items-center justify-center gap-1 text-label-small font-semibold">
        {ink.name}
      </span>
      <span className="block min-h-[1em] text-label-tiny text-on-surface-variant">
        {locked ?? ''}
      </span>
    </>
  );
  // Three rows on a fixed grid — dot, name, plan — so a colour without a plan
  // tag keeps its dot on the same line as the others rather than dropping to
  // sit on the baseline. `grid-rows-subgrid` takes the rows from the fieldset.
  const shell = cn(
    'state-layer grid grid-rows-subgrid row-span-3 justify-items-center rounded-lg px-1.5 pt-1.5 pb-1 text-center',
  );
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
  const { participant } = useApp();
  const [theme, setTheme] = useTheme();
  const { preference, surface, ink, choose } = useBoard();
  const plan = participant?.plan ?? 'free';

  // Only the colours that belong on the board actually in use. A chalk on a
  // whiteboard is not a disabled option, it is not an option.
  const colours = inksFor(surface.kind ?? 'marker');
  const chosenForKind: InkId = ink;

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
          title={surface.kind === 'chalk' ? 'Chalk' : 'Marker'}
          intro={
            surface.kind === 'chalk'
              ? 'What the expert writes with. Chalk belongs on a chalk board; pick a marker board and the markers appear instead.'
              : 'What the expert writes with. Markers belong on a marker board; pick a chalk board and the chalks appear instead.'
          }
        >
          <fieldset className="grid grid-cols-[repeat(auto-fill,minmax(60px,max-content))] grid-rows-[auto_auto_auto] items-start gap-x-0.5 border-0 p-0">
            <legend className="sr-only">
              {surface.kind === 'chalk' ? 'Chalk colour' : 'Marker colour'}
            </legend>
            {colours.map((c) => (
              <InkDot
                key={c.id}
                ink={c}
                surfaceId={surface.id}
                chosen={chosenForKind === c.id}
                locked={planAllowsInk(plan, c.id) ? null : planNameFor(c.minPlan)}
                onChoose={() => {
                  trackAction('ink_chosen', { ink: c.id, surface: surface.id });
                  choose({
                    ...preference,
                    // Written to the field for its own kind, so the other
                    // colour survives a trip to a different board and back.
                    [c.kind]: c.id,
                  });
                }}
              />
            ))}
          </fieldset>
        </Section>

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
