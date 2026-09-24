import type { FeatureFlagsHistoryEntry } from '@pen/contracts';
import { FEATURES, isFeatureName, isSettingName, SETTINGS } from '@pen/contracts';
import { Button, Card, Dialog, Pill, Skeleton } from '@pen/design';
import { useState } from 'react';
import {
  bySection,
  changedFeatures,
  changedSettings,
  draftRule,
  draftSetting,
  mutationRules,
  mutationSettings,
} from '../../lib/features-state.js';
import { showMoment } from '../../lib/presenters.js';
import { ConsolePage } from '../../shell/AdminShell.js';
import { describeChoice, describeRule, FeatureHistory } from './FeatureHistory.js';
import { FeatureRow } from './FeatureRow.js';
import { SettingRow } from './SettingRow.js';
import { useFeatures } from './use-features.js';

/**
 * The Features console (ADR-0036): what each plan gets on each platform.
 *
 * The same promises as Settings: nothing is a surprise, every save carries a
 * reason and lands as a numbered revision, and a save that collided with
 * somebody else's is refused with the draft intact. What is different is the
 * shape of a value — a matrix, drawn as one — and when a change lands: on
 * the next session, never under a lesson in progress.
 */
export function Features() {
  const { state, history, edit, editSettings, load, loadHistory, save, rollback } = useFeatures();
  const [reason, setReason] = useState('');
  const [restore, setRestore] = useState<FeatureFlagsHistoryEntry | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const [discarding, setDiscarding] = useState(false);

  const document = state.document;
  const editable = state.phase === 'READY' && !document?.stale;
  const saving = state.phase === 'SAVING';
  const changed = changedFeatures(state);
  const changedSettingNames = changedSettings(state);

  const reload = () => {
    setReason('');
    setRestore(null);
    setDiscarding(false);
    void load();
  };

  async function onSave() {
    if (!document || !editable || !state.dirty) return;
    if (
      await save({
        expectedRevision: document.revision,
        reason: reason.trim(),
        rules: mutationRules(state),
        settings: mutationSettings(state),
      })
    )
      setReason('');
  }

  async function onRestore() {
    if (!document || !restore || !editable || state.dirty) return;
    const done = await rollback({
      expectedRevision: document.revision,
      targetRevision: restore.revision,
      reason: restoreReason.trim(),
    });
    if (done) {
      setRestore(null);
      setRestoreReason('');
    }
  }

  const setHere =
    (document?.features.filter((f) => f.storedRule !== null).length ?? 0) +
    (document?.settings.filter((s) => s.storedRule !== null).length ?? 0);
  const lastSave = document ? showMoment(document.updatedAt) : null;

  return (
    <ConsolePage
      title="Features"
      width="wide"
      intro="What each plan gets on each platform. A plan or a platform answers for its whole row or column, a cell answers for itself, and the default stands where nothing does. A change reaches the next session; nothing changes for a lesson already in progress."
      actions={
        <>
          {state.dirty ? <Pill tone="warm">Unsaved changes</Pill> : null}
          <Button
            variant="secondary"
            disabled={saving || state.phase === 'LOADING'}
            onClick={() => (state.dirty ? setDiscarding(true) : reload())}
          >
            Reload
          </Button>
        </>
      }
    >
      {state.error ? (
        <p
          role="alert"
          className="rounded-sm bg-error-container p-4 text-body-medium text-on-error-container"
          data-testid="features-error"
        >
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p
          role="status"
          className="rounded-sm bg-primary-container p-4 text-body-medium text-on-primary-container"
          data-testid="features-notice"
        >
          {state.notice}
        </p>
      ) : null}
      {document?.stale ? (
        <p
          role="alert"
          className="rounded-sm bg-error-container p-4 text-body-medium text-on-error-container"
        >
          These are the last features the API managed to read; the store cannot be reached right
          now. The product is still running on them, and saving is refused until it can be read
          again.
        </p>
      ) : null}

      {state.phase === 'LOADING' && !document ? (
        <div className="flex flex-col gap-3" data-testid="features-loading">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : null}

      {document ? (
        <>
          <Card
            className="flex flex-wrap items-center gap-x-8 gap-y-3 p-5"
            data-testid="features-overview"
          >
            <Fact label="Revision" value={String(document.revision)} />
            <Fact
              label="Last changed"
              value={
                document.revision === 0
                  ? 'never'
                  : `${lastSave?.text ?? ''}${document.updatedByName ? ` · ${document.updatedByName}` : ''}`
              }
            />
            <Fact
              label="Set here"
              value={`${setHere} of ${document.features.length + document.settings.length}`}
            />
          </Card>

          {bySection(document.features, document.settings).map(([group, rows]) => (
            <section key={group} aria-labelledby={groupId(group)} className="flex flex-col">
              <h2 id={groupId(group)} className="text-title-large text-on-surface">
                {group}
              </h2>
              {rows.features.map((flag) => (
                <FeatureRow
                  key={flag.name}
                  flag={flag}
                  rule={draftRule(state.draft, flag)}
                  disabled={!editable}
                  onChange={(rule) => edit({ ...state.draft, [flag.name]: rule })}
                />
              ))}
              {rows.settings.map((row) => (
                <SettingRow
                  key={row.name}
                  row={row}
                  rule={draftSetting(state.settingsDraft, row)}
                  disabled={!editable}
                  onChange={(rule) => editSettings({ ...state.settingsDraft, [row.name]: rule })}
                />
              ))}
            </section>
          ))}

          <form
            className="flex flex-col gap-3 rounded-md bg-surface-container-low p-5 hairline"
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
            <label htmlFor="features-reason" className="text-title-small text-on-surface">
              Why are you changing this?
            </label>
            <p className="text-body-small text-on-surface-variant">
              {changed.length === 0 && changedSettingNames.length === 0
                ? 'Nothing is changed yet.'
                : `${[
                    changed.length > 0
                      ? `${changed.length} feature${changed.length === 1 ? '' : 's'}`
                      : null,
                    changedSettingNames.length > 0
                      ? `${changedSettingNames.length} setting${changedSettingNames.length === 1 ? '' : 's'}`
                      : null,
                  ]
                    .filter((part) => part !== null)
                    .join(', ')}: ${[
                    ...changed.map((name) => FEATURES[name].label),
                    ...changedSettingNames.map((name) => SETTINGS[name].label),
                  ].join(', ')}`}
            </p>
            <textarea
              id="features-reason"
              required
              maxLength={500}
              rows={2}
              value={reason}
              disabled={!editable}
              placeholder="Opening topic preparation to free for launch week."
              onChange={(e) => setReason(e.target.value)}
              className="w-full resize-y rounded-xs border border-outline bg-surface px-3 py-2 text-body-medium text-on-surface focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
              data-testid="features-save-reason"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-body-small text-on-surface-variant">
                {state.phase === 'RELOAD_REQUIRED'
                  ? 'Reload before saving again — what is on the server is no longer what this page was built from.'
                  : `Saved against revision ${document.revision}. Every change records who made it.`}
              </p>
              <Button
                type="submit"
                loading={saving}
                disabled={!editable || !state.dirty || reason.trim().length === 0}
                data-testid="save-features"
              >
                Save
              </Button>
            </div>
          </form>

          <FeatureHistory
            entries={history.entries}
            currentRevision={document.revision}
            loading={history.loading}
            error={history.error}
            nextBeforeRevision={history.nextBeforeRevision}
            canRestore={editable && !state.dirty}
            onRestore={(entry) => {
              setRestore(entry);
              setRestoreReason('');
            }}
            onRefresh={() => void loadHistory()}
            onLoadMore={() => {
              if (history.nextBeforeRevision !== null) void loadHistory(history.nextBeforeRevision);
            }}
          />
          {state.dirty ? (
            <p className="text-body-small text-on-surface-variant">
              Save or discard your changes before restoring an older revision.
            </p>
          ) : null}
        </>
      ) : null}

      <Dialog open={discarding} onClose={() => setDiscarding(false)} title="Discard your changes?">
        <p className="text-body-medium text-on-surface-variant">
          Reloading replaces what you have edited with the saved features. Nothing on the server
          changes either way.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDiscarding(false)}>
            Keep editing
          </Button>
          <Button onClick={reload}>Discard and reload</Button>
        </div>
      </Dialog>

      <Dialog
        open={restore !== null}
        onClose={() => {
          if (!saving) setRestore(null);
        }}
        title={restore ? `Restore revision ${restore.revision}` : 'Restore'}
      >
        <p className="text-body-medium text-on-surface-variant">
          This saves that revision's features again as a new one. The revisions after it stay in the
          history exactly as they are.
        </p>
        {restore ? (
          <ul className="mt-4 divide-y divide-outline-variant rounded-sm bg-surface-container">
            {Object.keys(restore.rules).length === 0 &&
            Object.keys(restore.settings).length === 0 ? (
              <li className="px-4 py-2.5 text-body-medium text-on-surface-variant">
                Every feature and setting back to its built-in rule.
              </li>
            ) : (
              <>
                {Object.keys(restore.rules)
                  .sort()
                  .map((name) => {
                    const rule = restore.rules[name as keyof typeof restore.rules];
                    return (
                      <li
                        key={name}
                        className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-body-medium"
                      >
                        <span className="text-on-surface">
                          {isFeatureName(name) ? FEATURES[name].label : name}
                        </span>
                        <span className="text-on-surface-variant">
                          {rule ? describeRule(rule) : ''}
                        </span>
                      </li>
                    );
                  })}
                {Object.keys(restore.settings)
                  .sort()
                  .map((name) => {
                    const rule = restore.settings[name as keyof typeof restore.settings];
                    return (
                      <li
                        key={name}
                        className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-body-medium"
                      >
                        <span className="text-on-surface">
                          {isSettingName(name) ? SETTINGS[name].label : name}
                        </span>
                        <span className="text-on-surface-variant">
                          {rule && isSettingName(name)
                            ? describeChoice(rule, SETTINGS[name].valueLabels)
                            : ''}
                        </span>
                      </li>
                    );
                  })}
              </>
            )}
          </ul>
        ) : null}
        <label
          htmlFor="features-restore-reason"
          className="mt-5 block text-title-small text-on-surface"
        >
          Why are you restoring it?
        </label>
        <textarea
          id="features-restore-reason"
          required
          maxLength={500}
          rows={2}
          value={restoreReason}
          disabled={!editable}
          onChange={(e) => setRestoreReason(e.target.value)}
          className="mt-2 w-full resize-y rounded-xs border border-outline bg-surface px-3 py-2 text-body-medium text-on-surface focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
        />
        {state.error ? (
          <p role="alert" className="mt-3 text-body-small text-error">
            {state.error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" disabled={saving} onClick={() => setRestore(null)}>
            Cancel
          </Button>
          <Button
            loading={saving}
            disabled={!editable || restoreReason.trim().length === 0}
            onClick={() => void onRestore()}
          >
            Restore as a new revision
          </Button>
        </div>
      </Dialog>
    </ConsolePage>
  );
}

function groupId(group: string): string {
  return `features-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-body-small text-on-surface-variant">{label}</div>
      <div className="mt-0.5 text-title-small text-on-surface">{value}</div>
    </div>
  );
}
