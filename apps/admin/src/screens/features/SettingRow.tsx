import type { ChoiceRule, SettingRow as SettingRowData } from '@pen/contracts';
import {
  cellKey,
  choicesEqual,
  PLAN_NAME,
  PLATFORM_LABEL,
  PLATFORMS,
  PlanCode as PlanCodeSchema,
  resolveChoice,
  SHIPPED_PLATFORMS,
} from '@pen/contracts';
import { Button, cn, Pill } from '@pen/design';
import { Plus, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import {
  type Choice,
  setChoiceAnonymous,
  setChoiceCellAnswer,
  setChoiceDefault,
  setChoiceParticipant,
  setChoicePlanAnswer,
  setChoicePlatformAnswer,
} from '../../lib/features-state.js';

/** The shape an account id has when the API issued it; the service checks the account itself. */
const PARTICIPANT_ID = /^p_[A-Za-z0-9_-]{4,64}$/;

/**
 * One setting, as a matrix (ADR-0048): the same grid as a feature flag, but
 * every head and every cell names a *value* instead of switching a bit, and
 * two more things speak — the visitor, and named accounts, which come before
 * everything else. A select that says nothing inherits, and the cell always
 * shows what actually resolves, drawn lighter when nobody decided it there.
 */
export function SettingRow({
  row,
  rule,
  disabled,
  onChange,
}: {
  row: SettingRowData;
  /** The draft's rule for this setting. */
  rule: ChoiceRule;
  disabled: boolean;
  onChange: (rule: ChoiceRule) => void;
}) {
  const id = `setting-${row.name}`;
  const changed = !choicesEqual(rule, row.effectiveRule);
  const overridden = !choicesEqual(rule, row.defaultRule);
  const plans = PlanCodeSchema.options;
  const label = (value: string) => row.valueLabels[value] ?? value;
  const [newId, setNewId] = useState('');
  const [newValue, setNewValue] = useState(row.values[0] ?? '');
  const participants = Object.entries(rule.participants).sort(([a], [b]) => a.localeCompare(b));
  const canAdd =
    !disabled && PARTICIPANT_ID.test(newId.trim()) && rule.participants[newId.trim()] === undefined;

  const selectClass =
    'h-9 rounded-sm border border-outline-variant bg-surface px-2 text-label-medium text-on-surface focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40';

  return (
    <div
      className="grid gap-5 border-outline-variant border-t py-6 xl:grid-cols-[minmax(0,1fr)_auto]"
      data-testid={id}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${id}-label`} className="text-title-small text-on-surface">
            {row.label}
          </h3>
          {changed ? <Pill tone="warm">Unsaved</Pill> : null}
          {row.storedRule ? <Pill tone="neutral">Set here</Pill> : null}
        </div>
        <p className="mt-1.5 max-w-[60ch] text-body-small text-on-surface-variant">
          {row.description}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small text-on-surface-variant">
          <code className="font-mono">{row.name}</code>
          <span aria-hidden>·</span>
          <span>Takes effect on the next session</span>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <label className="flex items-center gap-2 text-body-medium text-on-surface">
            <span>By default</span>
            <select
              className={selectClass}
              value={rule.default}
              disabled={disabled}
              onChange={(e) => onChange(setChoiceDefault(rule, e.target.value))}
              data-testid={`${id}-default`}
            >
              {row.values.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2 text-body-medium text-on-surface">
            <span aria-hidden>For a visitor without an account</span>
            <ChoiceSelect
              className={selectClass}
              values={row.values}
              label={label}
              choice={rule.anonymous}
              disabled={disabled}
              aria-label={`${row.label} for a visitor without an account`}
              data-testid={`${id}-anonymous`}
              onChange={(choice) => onChange(setChoiceAnonymous(rule, choice))}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            leading={<RotateCcw size={15} aria-hidden />}
            disabled={disabled || !overridden}
            aria-label={`Use the built-in rule for ${row.label}`}
            onClick={() => onChange(row.defaultRule)}
          >
            Use built-in rule
          </Button>
        </div>

        {/* Named accounts: the most specific statement there is, so it is
            listed apart from the grid, with the id in full. */}
        <section
          aria-labelledby={`${id}-participants-title`}
          className="mt-5 flex flex-col gap-2"
          data-testid={`${id}-participants`}
        >
          <h4 id={`${id}-participants-title`} className="text-label-large text-on-surface">
            Specific accounts
          </h4>
          {participants.length === 0 ? (
            <p className="text-body-small text-on-surface-variant">
              No account has an answer of its own.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {participants.map(([participantId, value]) => (
                <li
                  key={participantId}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`${id}-participant-${participantId}`}
                >
                  <code className="font-mono text-body-small text-on-surface">{participantId}</code>
                  <select
                    className={selectClass}
                    value={value}
                    disabled={disabled}
                    aria-label={`${row.label} for account ${participantId}`}
                    onChange={(e) =>
                      onChange(setChoiceParticipant(rule, participantId, e.target.value))
                    }
                  >
                    {row.values.map((v) => (
                      <option key={v} value={v}>
                        {label(v)}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Remove the answer for account ${participantId}`}
                    leading={<X size={15} aria-hidden />}
                    onClick={() => onChange(setChoiceParticipant(rule, participantId, undefined))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canAdd) return;
              onChange(setChoiceParticipant(rule, newId.trim(), newValue));
              setNewId('');
            }}
          >
            <input
              type="text"
              value={newId}
              disabled={disabled}
              placeholder="p_…"
              aria-label={`Account id to answer for ${row.label}`}
              spellCheck={false}
              onChange={(e) => setNewId(e.target.value)}
              className="h-9 w-56 rounded-sm border border-outline-variant bg-surface px-3 font-mono text-body-small text-on-surface placeholder:text-on-surface-dim focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
              data-testid={`${id}-participant-id`}
            />
            <select
              className={selectClass}
              value={newValue}
              disabled={disabled}
              aria-label={`Answer for the new account on ${row.label}`}
              onChange={(e) => setNewValue(e.target.value)}
              data-testid={`${id}-participant-value`}
            >
              {row.values.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={!canAdd}
              leading={<Plus size={15} aria-hidden />}
              data-testid={`${id}-participant-add`}
            >
              Add
            </Button>
          </form>
        </section>
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
                  <Head
                    label={PLATFORM_LABEL[platform]}
                    detail={SHIPPED_PLATFORMS.includes(platform) ? null : 'not yet'}
                    choice={rule.platforms[platform]}
                    values={row.values}
                    valueLabel={label}
                    disabled={disabled}
                    aria-label={`${row.label} on ${PLATFORM_LABEL[platform]}, every plan: ${describe(rule.platforms[platform], label)}`}
                    data-testid={`${id}-platform-${platform}`}
                    onChange={(choice) => onChange(setChoicePlatformAnswer(rule, platform, choice))}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan}>
                <th scope="row" className="p-0 text-left font-normal">
                  <Head
                    label={PLAN_NAME[plan]}
                    detail={null}
                    choice={rule.plans[plan]}
                    values={row.values}
                    valueLabel={label}
                    disabled={disabled}
                    aria-label={`${row.label} for ${PLAN_NAME[plan]}, every platform: ${describe(rule.plans[plan], label)}`}
                    data-testid={`${id}-plan-${plan}`}
                    onChange={(choice) => onChange(setChoicePlanAnswer(rule, plan, choice))}
                  />
                </th>
                {PLATFORMS.map((platform) => {
                  const own = rule.cells[cellKey(plan, platform)];
                  const resolved = resolveChoice(rule, plan, platform);
                  return (
                    <td key={platform} className="p-0">
                      <ChoiceSelect
                        className={cn(
                          'h-9 w-full min-w-[5.5rem] rounded-sm border px-1.5 text-label-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary',
                          own !== undefined
                            ? 'border-primary bg-primary-container text-on-primary-container'
                            : 'border-transparent bg-surface-container text-on-surface-variant',
                          disabled && 'opacity-40',
                        )}
                        values={row.values}
                        label={label}
                        choice={own}
                        resolved={resolved}
                        disabled={disabled}
                        aria-label={`${row.label}: ${PLAN_NAME[plan]} on ${PLATFORM_LABEL[platform]}: ${label(resolved)}${own !== undefined ? ', set for this cell' : ', inherited'}`}
                        data-testid={`${id}-cell-${plan}-${platform}`}
                        onChange={(choice) =>
                          onChange(setChoiceCellAnswer(rule, plan, platform, choice))
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function describe(choice: Choice, label: (v: string) => string): string {
  return choice === undefined ? 'no answer of its own' : label(choice);
}

/**
 * A select whose first option says nothing. When it says nothing and a
 * `resolved` value is given, that value is shown in the option's text, so a
 * cell reads as what it resolves to while still being "inherit".
 */
function ChoiceSelect({
  values,
  label,
  choice,
  resolved,
  disabled,
  onChange,
  className,
  ...rest
}: {
  values: readonly string[];
  label: (v: string) => string;
  choice: Choice;
  resolved?: string;
  disabled: boolean;
  onChange: (choice: Choice) => void;
  className: string;
  'aria-label': string;
  'data-testid': string;
}) {
  return (
    <select
      className={className}
      value={choice ?? ''}
      disabled={disabled}
      data-resolved={resolved}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      {...rest}
    >
      <option value="">{resolved !== undefined ? `${label(resolved)} ·` : 'inherit'}</option>
      {values.map((value) => (
        <option key={value} value={value}>
          {label(value)}
        </option>
      ))}
    </select>
  );
}

/** A plan or platform head: the axis's own answer, or nothing. */
function Head({
  label,
  detail,
  choice,
  values,
  valueLabel,
  disabled,
  onChange,
  ...rest
}: {
  label: string;
  detail: string | null;
  choice: Choice;
  values: readonly string[];
  valueLabel: (v: string) => string;
  disabled: boolean;
  onChange: (choice: Choice) => void;
  'aria-label': string;
  'data-testid': string;
}) {
  return (
    <div className="flex min-w-[5.5rem] flex-col items-stretch gap-1 px-0.5">
      <span className="text-label-medium text-on-surface leading-tight">
        {label}
        {detail ? (
          <span className="ml-1 text-label-small text-on-surface-dim">{detail}</span>
        ) : null}
      </span>
      <ChoiceSelect
        className={cn(
          'h-8 w-full rounded-sm border px-1.5 text-label-small transition-colors focus-visible:outline-2 focus-visible:outline-primary',
          choice !== undefined
            ? 'border-secondary bg-secondary-container text-on-secondary-container'
            : 'border-outline-variant bg-surface text-on-surface-variant',
          disabled && 'opacity-40',
        )}
        values={values}
        label={valueLabel}
        choice={choice}
        disabled={disabled}
        onChange={onChange}
        {...rest}
      />
    </div>
  );
}
