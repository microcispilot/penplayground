import type { FeatureFlag, FeatureRule } from '@pen/contracts';
import {
  cellKey,
  PLAN_NAME,
  PLATFORM_LABEL,
  PLATFORMS,
  PlanCode as PlanCodeSchema,
  resolveRule,
  rulesEqual,
  SHIPPED_PLATFORMS,
} from '@pen/contracts';
import { Button, cn, Pill } from '@pen/design';
import { Check, Minus, RotateCcw } from 'lucide-react';
import {
  type Answer,
  nextAnswer,
  setCellAnswer,
  setDefault,
  setPlanAnswer,
  setPlatformAnswer,
} from '../../lib/features-state.js';

/**
 * One feature, as a matrix (ADR-0036): every plan down the side, every
 * platform across the top, and in each cell what that learner gets. Three
 * kinds of control, all on the same grid:
 *
 *  - a **cell** answers for exactly one plan on one platform;
 *  - a **row head** (a plan) answers for that plan on every platform, and a
 *    **column head** (a platform) for that platform on every plan; the two
 *    AND when both speak;
 *  - the **default** is what stands when none of them does.
 *
 * A click cycles nothing → on → off → nothing, and the cell always shows
 * what actually resolves — so an operator can see the consequence of a
 * header before saving it, and a cell that merely inherits is drawn lighter
 * than one somebody decided. Platforms that do not ship yet are there too,
 * marked, so a flag can be set before the app exists.
 */
export function FeatureRow({
  flag,
  rule,
  disabled,
  onChange,
}: {
  flag: FeatureFlag;
  /** The draft's rule for this feature. */
  rule: FeatureRule;
  disabled: boolean;
  onChange: (rule: FeatureRule) => void;
}) {
  const id = `feature-${flag.name}`;
  const changed = !rulesEqual(rule, flag.effectiveRule);
  const overridden = !rulesEqual(rule, flag.defaultRule);
  const plans = PlanCodeSchema.options;

  return (
    <div
      className="grid gap-5 border-outline-variant border-t py-6 xl:grid-cols-[minmax(0,1fr)_auto]"
      data-testid={id}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${id}-label`} className="text-title-small text-on-surface">
            {flag.label}
          </h3>
          {changed ? <Pill tone="warm">Unsaved</Pill> : null}
          {flag.storedRule ? <Pill tone="neutral">Set here</Pill> : null}
        </div>
        <p className="mt-1.5 max-w-[60ch] text-body-small text-on-surface-variant">
          {flag.description}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small text-on-surface-variant">
          <code className="font-mono">{flag.name}</code>
          <span aria-hidden>·</span>
          <span>Takes effect on the next session</span>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-body-medium text-on-surface">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={rule.default}
              disabled={disabled}
              onChange={(e) => onChange(setDefault(rule, e.target.checked))}
              data-testid={`${id}-default`}
            />
            On by default
          </label>
          <Button
            variant="ghost"
            size="sm"
            leading={<RotateCcw size={15} aria-hidden />}
            disabled={disabled || !overridden}
            aria-label={`Use the built-in rule for ${flag.label}`}
            onClick={() => onChange(flag.defaultRule)}
          >
            Use built-in rule
          </Button>
        </div>
      </div>

      {/* Six platforms and a row head are wider than a phone: the matrix
          scrolls inside its own row, never the page. */}
      <div className="max-w-full overflow-x-auto">
        <table
          className="border-separate border-spacing-1 self-start text-body-small"
          aria-labelledby={`${id}-label`}
          data-testid={`${id}-matrix`}
        >
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Plan
              </th>
              {PLATFORMS.map((platform) => (
                <th key={platform} scope="col" className="p-0 font-normal">
                  <HeadButton
                    label={PLATFORM_LABEL[platform]}
                    detail={SHIPPED_PLATFORMS.includes(platform) ? null : 'not yet'}
                    answer={rule.platforms[platform]}
                    disabled={disabled}
                    aria-label={`${flag.label} on ${PLATFORM_LABEL[platform]}, every plan: ${describe(rule.platforms[platform])}`}
                    data-testid={`${id}-platform-${platform}`}
                    onClick={() =>
                      onChange(
                        setPlatformAnswer(rule, platform, nextAnswer(rule.platforms[platform])),
                      )
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan}>
                <th scope="row" className="p-0 text-left font-normal">
                  <HeadButton
                    label={PLAN_NAME[plan]}
                    detail={null}
                    answer={rule.plans[plan]}
                    disabled={disabled}
                    aria-label={`${flag.label} for ${PLAN_NAME[plan]}, every platform: ${describe(rule.plans[plan])}`}
                    data-testid={`${id}-plan-${plan}`}
                    onClick={() =>
                      onChange(setPlanAnswer(rule, plan, nextAnswer(rule.plans[plan])))
                    }
                  />
                </th>
                {PLATFORMS.map((platform) => (
                  <td key={platform} className="p-0">
                    <Cell
                      on={resolveRule(rule, plan, platform)}
                      answer={rule.cells[cellKey(plan, platform)]}
                      disabled={disabled}
                      label={`${flag.label}: ${PLAN_NAME[plan]} on ${PLATFORM_LABEL[platform]}`}
                      data-testid={`${id}-cell-${plan}-${platform}`}
                      onClick={() =>
                        onChange(
                          setCellAnswer(
                            rule,
                            plan,
                            platform,
                            nextAnswer(rule.cells[cellKey(plan, platform)]),
                          ),
                        )
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function describe(answer: Answer): string {
  return answer === undefined ? 'no answer of its own' : answer ? 'on' : 'off';
}

/** A plan or platform head: the axis's own answer, with the cycle on click. */
function HeadButton({
  label,
  detail,
  answer,
  disabled,
  onClick,
  ...rest
}: {
  label: string;
  detail: string | null;
  answer: Answer;
  disabled: boolean;
  onClick: () => void;
  'aria-label': string;
  'data-testid': string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'state-layer flex h-9 min-w-[3.5rem] flex-col sm:min-w-[4.25rem] items-center justify-center rounded-sm px-2 text-label-medium leading-tight transition-colors',
        answer === undefined
          ? 'text-on-surface-variant'
          : answer
            ? 'bg-secondary-container text-on-secondary-container'
            : 'bg-surface-container-highest text-on-surface line-through decoration-outline',
        disabled && 'opacity-40',
      )}
      {...rest}
    >
      <span>{label}</span>
      {detail ? (
        <span className="text-label-small text-on-surface-dim no-underline">{detail}</span>
      ) : null}
    </button>
  );
}

/** One cell: what resolves, drawn heavier when somebody decided it here. */
function Cell({
  on,
  answer,
  disabled,
  label,
  onClick,
  ...rest
}: {
  on: boolean;
  answer: Answer;
  disabled: boolean;
  label: string;
  onClick: () => void;
  'data-testid': string;
}) {
  const decided = answer !== undefined;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${label}: ${on ? 'on' : 'off'}${decided ? ', set for this cell' : ', inherited'}`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'state-layer grid size-9 place-items-center rounded-sm transition-colors',
        on
          ? decided
            ? 'bg-primary text-on-primary'
            : 'bg-primary-container text-on-primary-container'
          : decided
            ? 'bg-surface-container-highest text-on-surface hairline'
            : 'bg-surface-container text-on-surface-dim',
        disabled && 'opacity-40',
      )}
      {...rest}
    >
      {on ? <Check size={15} aria-hidden /> : <Minus size={15} aria-hidden />}
    </button>
  );
}
