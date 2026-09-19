import type { RuntimeSetting, RuntimeSettingValue } from '@pen/contracts';
import { Button, cn, Pill } from '@pen/design';
import { RotateCcw } from 'lucide-react';
import { SCOPE_NOTE, showValue } from '../../lib/presenters.js';
import { wouldRun } from '../../lib/runtime-config-state.js';

/** The sentinel a choice uses for "no value"; the API turns it back into nothing. */
const UNSET = 'unset';

const field =
  'h-10 w-full rounded-xs border border-outline bg-surface px-3 text-body-medium text-on-surface transition-colors focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40';

/**
 * One setting, as a row: what it is, what it is set to, what the code does
 * without it, and where the value in force came from (ADR-0026).
 *
 * The row never hides the default behind the control. An operator changing a
 * model at nine in the evening should be able to see, without clicking
 * anything, what they are moving away from and what would come back if they
 * cleared it.
 */
export function SettingRow({
  setting,
  value,
  disabled,
  onChange,
}: {
  setting: RuntimeSetting;
  /** The draft's value: null means "no override, use the default". */
  value: RuntimeSettingValue | null;
  disabled: boolean;
  onChange: (value: RuntimeSettingValue | null) => void;
}) {
  const id = `setting-${setting.name}`;
  const changed = value !== setting.storedValue;
  const overridden = value !== null;
  const describedBy = `${id}-help`;

  return (
    <div
      className={cn(
        'grid gap-4 border-outline-variant border-t py-5 sm:grid-cols-[minmax(0,1fr)_20rem]',
        setting.pinnedByEnv && 'opacity-90',
      )}
      data-testid={`setting-${setting.name}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="text-title-small text-on-surface">
            {setting.label}
          </label>
          {changed ? <Pill tone="warm">Unsaved</Pill> : null}
          {setting.pinnedByEnv ? <Pill tone="neutral">Pinned on this server</Pill> : null}
        </div>
        <p id={describedBy} className="mt-1.5 max-w-[60ch] text-body-small text-on-surface-variant">
          {setting.description}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small text-on-surface-variant">
          <code className="font-mono text-on-surface-variant">{setting.env}</code>
          <span aria-hidden>·</span>
          <span>{SCOPE_NOTE[setting.scope]}</span>
          <span aria-hidden>·</span>
          <span>
            Default <strong className="text-on-surface">{showValue(setting.defaultValue)}</strong>
          </span>
          <span aria-hidden>·</span>
          <span>
            In force now{' '}
            <strong className="text-on-surface">{showValue(setting.effectiveValue)}</strong>
          </span>
        </p>
        {setting.pinnedByEnv ? (
          <p className="mt-2 text-body-small text-on-surface-variant">
            This server sets <code className="font-mono">{setting.env}</code> in its environment, so
            it keeps running on{' '}
            <strong className="text-on-surface">{showValue(setting.effectiveValue)}</strong>{' '}
            whatever is saved here. Other servers will follow what is saved.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Control
          id={id}
          describedBy={describedBy}
          setting={setting}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-body-small text-on-surface-variant">
            {/* Once the draft has moved, the useful sentence is not "set here"
                but what this server would actually be running afterwards —
                which, on a pinned setting, is not what the control says. */}
            {changed
              ? `After saving · ${showValue(wouldRun(value, setting).value)}`
              : overridden
                ? 'Set here'
                : 'Using the default'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            leading={<RotateCcw size={15} aria-hidden />}
            disabled={disabled || !overridden}
            onClick={() => onChange(null)}
          >
            Use default
          </Button>
        </div>
      </div>
    </div>
  );
}

function Control({
  id,
  describedBy,
  setting,
  value,
  disabled,
  onChange,
}: {
  id: string;
  describedBy: string;
  setting: RuntimeSetting;
  value: RuntimeSettingValue | null;
  disabled: boolean;
  onChange: (value: RuntimeSettingValue | null) => void;
}) {
  if (setting.kind === 'choice') {
    // "Use the default" is an option in the list rather than a separate
    // control: on a choice, "unset" is just one more thing it can be.
    const current = value === null ? '' : String(value);
    return (
      <select
        id={id}
        aria-describedby={describedBy}
        className={field}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">Default — {showValue(setting.defaultValue)}</option>
        {(setting.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option === UNSET ? 'unset (send no value)' : option}
          </option>
        ))}
      </select>
    );
  }
  if (setting.kind === 'boolean') {
    const current = value === null ? '' : value ? 'on' : 'off';
    return (
      <select
        id={id}
        aria-describedby={describedBy}
        className={field}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'on')}
      >
        <option value="">Default — {showValue(setting.defaultValue)}</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    );
  }
  if (setting.kind === 'number')
    return (
      <input
        id={id}
        aria-describedby={describedBy}
        className={field}
        type="number"
        inputMode="numeric"
        {...(setting.min === undefined ? {} : { min: setting.min })}
        {...(setting.max === undefined ? {} : { max: setting.max })}
        placeholder={`Default — ${showValue(setting.defaultValue)}`}
        value={value === null ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') return onChange(null);
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : raw);
        }}
      />
    );
  return (
    <input
      id={id}
      aria-describedby={describedBy}
      className={field}
      type="text"
      autoComplete="off"
      spellCheck={false}
      placeholder={`Default — ${showValue(setting.defaultValue)}`}
      value={value === null ? '' : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    />
  );
}
