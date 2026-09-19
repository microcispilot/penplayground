import type { Expert, PlanCode } from '@pen/contracts';
import { PLAN_NAME, planIncludes } from '@pen/contracts';
import { cn } from '@pen/design';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router';
import { useApp } from '../lib/context.js';

/**
 * One persona, as a portrait tile — the same card on Home's row and on the
 * Experts page, so a learner sees one thing in two places and the plan rule
 * is written once.
 *
 * The rule itself is the server's: every expert arrives with `requiredPlan`
 * stamped on it (`expert-access.ts`), and this only renders what it was told.
 * A persona the learner's plan does not include is not hidden and not greyed
 * into a dead tile — the portrait stays legible, the card carries the plan's
 * name, and choosing it goes to Pricing. It says what the plan gives, never
 * what the learner is missing: "Included with Standard", no padlock, no
 * imperative.
 */
export function useExpertLock(expert: Expert): {
  locked: boolean;
  requiredPlan: PlanCode | null;
  planName: string | null;
} {
  const { participant } = useApp();
  const requiredPlan = expert.requiredPlan;
  const plan: PlanCode = participant?.plan ?? 'free';
  return {
    locked: !planIncludes(plan, requiredPlan),
    requiredPlan,
    planName: requiredPlan ? PLAN_NAME[requiredPlan] : null,
  };
}

export interface ExpertCardProps {
  expert: Expert;
  portraitUrl: string | null;
  /** Shown under the role on the Experts page, where breadth is the point. */
  domainLabel?: string;
  /**
   * Chosen as the session's expert. Only Home's row is a chooser; leaving this
   * out makes the tile a plain link-like control rather than a toggle, which
   * is what the Experts page needs — an `aria-pressed="false"` there would
   * announce a switch that does not exist.
   */
  selected?: boolean | undefined;
  onChoose: () => void;
  className?: string;
  /** Portrait width to request and to size the <img> with. */
  width?: number;
}

export function ExpertCard({
  expert,
  portraitUrl,
  domainLabel,
  selected,
  onChoose,
  className,
  width = 192,
}: ExpertCardProps) {
  const { locked, planName } = useExpertLock(expert);
  const shell = cn(
    'group relative aspect-[4/5] overflow-hidden rounded-xl bg-surface-container-high text-left shadow-level1',
    'transition-[transform,box-shadow] duration-[var(--duration-slow)] ease-[var(--ease-out)] hover:-translate-y-1 hover:shadow-level3',
    selected === true && 'ring-[3px] ring-primary ring-offset-2 ring-offset-bg',
    className,
  );
  const inner = (
    <>
      {portraitUrl ? (
        <img
          src={portraitUrl}
          alt={expert.portrait?.alt ?? expert.displayName}
          loading="lazy"
          decoding="async"
          width={width}
          height={Math.round(width * 1.25)}
          className={cn(
            'absolute inset-0 size-full object-cover transition-transform duration-[600ms] ease-[var(--ease-out)] group-hover:scale-[1.04]',
            // Subdued, never dead: the face stays a face, it simply sits back.
            locked && 'opacity-[0.72] saturate-[0.85]',
          )}
        />
      ) : null}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[62%]"
        style={{
          background:
            'linear-gradient(to top, oklch(0.2 0.05 248 / 93%), oklch(0.2 0.05 248 / 0%))',
        }}
      />
      {locked && planName ? (
        <span
          className="absolute top-2.5 left-2.5 rounded-full bg-surface-container/92 px-2 py-[3px] text-label-small font-medium text-on-surface backdrop-blur"
          data-testid="expert-plan-chip"
        >
          {planName}
        </span>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-3.5 text-white">
        <span className="text-body-medium font-medium leading-tight">{expert.displayName}</span>
        <span className="line-clamp-2 text-body-small leading-snug text-white/75">
          {expert.role}
        </span>
        {locked && planName ? (
          <span className="mt-1 text-label-small text-white/70">Included with {planName}</span>
        ) : domainLabel ? (
          <span className="mt-1 text-label-small text-white/60">{domainLabel}</span>
        ) : null}
      </div>
      <span className="absolute top-2.5 right-2.5 grid size-8 place-items-center rounded-full bg-white/15 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        <ArrowUpRight size={15} />
      </span>
    </>
  );

  if (locked && planName) {
    return (
      <Link
        to="/pricing"
        data-testid="expert-tile"
        data-locked="true"
        aria-label={`${expert.displayName}, ${expert.role}. Included with ${planName}. See the plans.`}
        className={shell}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      data-testid="expert-tile"
      {...(selected === undefined ? {} : { 'aria-pressed': selected })}
      title={`Learn with ${expert.displayName}`}
      onClick={onChoose}
      className={shell}
    >
      {inner}
    </button>
  );
}

/**
 * The card that ends Home's expert row. Facebook and Google both close a
 * capped row with one more tile rather than a button somewhere else on the
 * page: the gesture that got you here — scrolling right — is the gesture that
 * finishes it, and the row keeps its rhythm.
 */
export function ShowMoreExpertsCard({ total, className }: { total: number; className?: string }) {
  return (
    <Link
      to="/experts"
      data-testid="experts-show-more"
      className={cn(
        'group relative flex aspect-[4/5] flex-col items-center justify-center gap-3 rounded-xl bg-surface-container-low text-center shadow-level1 hairline',
        'transition-[transform,box-shadow] duration-[var(--duration-slow)] ease-[var(--ease-out)] hover:-translate-y-1 hover:shadow-level3',
        className,
      )}
    >
      <span className="grid size-11 place-items-center rounded-full bg-primary-container text-on-primary-container transition-transform duration-[var(--duration-base)] group-hover:translate-x-0.5">
        <ArrowRight size={20} />
      </span>
      <span className="px-4 text-label-large font-medium text-on-surface">Show more</span>
      <span className="px-4 text-body-small text-on-surface-dim">
        {total > 0 ? `All ${total} experts` : 'All experts'}
      </span>
    </Link>
  );
}
