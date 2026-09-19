import type { RuntimeConfigHistoryEntry } from '@pen/contracts';
import { Button, Card, Dialog, Pill, Skeleton } from '@pen/design';
import { useState } from 'react';
import { overview, showMoment, showValue } from '../../lib/presenters.js';
import { byGroup, changedSettings, draftValue } from '../../lib/runtime-config-state.js';
import { ConsolePage } from '../../shell/AdminShell.js';
import { RevisionHistory } from './RevisionHistory.js';
import { SettingRow } from './SettingRow.js';
import { useRuntimeConfig } from './use-runtime-config.js';

/**
 * The settings console (ADR-0025, ADR-0026).
 *
 * The page is built around one promise: nothing here is ever a surprise. Each
 * row says what the code does without it, what is saved, and what this server
 * is actually running on. Every save carries a reason and lands as a numbered
 * revision. And a save that collided with somebody else's is refused with the
 * draft intact, rather than winning quietly.
 */
export function Settings() {
  const { state, history, edit, load, loadHistory, save, rollback } = useRuntimeConfig();
  const [reason, setReason] = useState('');
  const [restore, setRestore] = useState<RuntimeConfigHistoryEntry | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const [discarding, setDiscarding] = useState(false);

  const document = state.document;
  // Not editable on a stale document: it came off the last known good copy
  // rather than the database, so there is nothing to compare-and-set against
  // and a save could only fail.
  const editable = state.phase === 'READY' && !document?.stale;
  const saving = state.phase === 'SAVING';
  const changed = changedSettings(state);

  const reload = () => {
    setReason('');
    setRestore(null);
    setDiscarding(false);
    void load();
  };

  async function onSave() {
    if (!document || !editable || !state.dirty) return;
    const settings: Record<string, string | number | boolean | null> = {};
    for (const setting of document.settings)
      settings[setting.name] = draftValue(state.draft, setting);
    if (await save({ expectedRevision: document.revision, reason: reason.trim(), settings }))
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

  const counts = overview(document?.settings ?? []);
  const lastSave = document ? showMoment(document.updatedAt) : null;

  return (
    <ConsolePage
      title="Settings"
      intro="What this deployment runs on — which models teach, how it sounds, what a day may cost. A change here reaches every API process within seconds; nothing changes for a lesson already in progress."
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
          data-testid="settings-error"
        >
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p
          role="status"
          className="rounded-sm bg-primary-container p-4 text-body-medium text-on-primary-container"
          data-testid="settings-notice"
        >
          {state.notice}
        </p>
      ) : null}
      {document?.stale ? (
        <p
          role="alert"
          className="rounded-sm bg-error-container p-4 text-body-medium text-on-error-container"
        >
          These are the last settings the API managed to read; the store cannot be reached right
          now. The product is still running on them, and saving is refused until it can be read
          again.
        </p>
      ) : null}

      {state.phase === 'LOADING' && !document ? (
        <div className="flex flex-col gap-3" data-testid="settings-loading">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : null}

      {document ? (
        <>
          <Card
            className="flex flex-wrap items-center gap-x-8 gap-y-3 p-5"
            data-testid="settings-overview"
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
            <Fact label="Changed from default" value={`${counts.changed} of ${counts.total}`} />
            {counts.pinned > 0 ? (
              <Fact label="Pinned on this server" value={String(counts.pinned)} />
            ) : null}
            {counts.needsRestart > 0 ? (
              <Fact
                label="Waiting for a restart"
                value={`${counts.needsRestart} setting${counts.needsRestart === 1 ? '' : 's'}`}
              />
            ) : null}
          </Card>

          {byGroup(document.settings).map(([group, settings]) => (
            // A group name with a space in it is not a legal id, and
            // `aria-labelledby` would parse it as two idrefs that do not
            // exist — leaving the section with no name at all.
            <section key={group} aria-labelledby={groupId(group)} className="flex flex-col">
              <h2 id={groupId(group)} className="text-title-large text-on-surface">
                {group}
              </h2>
              {settings.map((setting) => (
                <SettingRow
                  key={setting.name}
                  setting={setting}
                  value={draftValue(state.draft, setting)}
                  disabled={!editable}
                  onChange={(value) => edit({ ...state.draft, [setting.name]: value })}
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
            <label htmlFor="save-reason" className="text-title-small text-on-surface">
              Why are you changing this?
            </label>
            <p className="text-body-small text-on-surface-variant">
              {changed.length === 0
                ? 'Nothing is changed yet.'
                : `${changed.length} setting${changed.length === 1 ? '' : 's'}: ${changed.join(', ')}`}
            </p>
            <textarea
              id="save-reason"
              required
              maxLength={500}
              rows={2}
              value={reason}
              disabled={!editable}
              placeholder="Trying the faster model for a week."
              onChange={(e) => setReason(e.target.value)}
              className="w-full resize-y rounded-xs border border-outline bg-surface px-3 py-2 text-body-medium text-on-surface focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
              data-testid="save-reason"
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
                data-testid="save-settings"
              >
                Save
              </Button>
            </div>
          </form>

          <RevisionHistory
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
          Reloading replaces what you have edited with the saved settings. Nothing on the server
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
          This saves that revision's settings again as a new one. The revisions after it stay in the
          history exactly as they are.
        </p>
        {restore ? (
          <ul className="mt-4 divide-y divide-outline-variant rounded-sm bg-surface-container">
            {Object.keys(restore.settings).length === 0 ? (
              <li className="px-4 py-2.5 text-body-medium text-on-surface-variant">
                Everything back to its default.
              </li>
            ) : (
              Object.keys(restore.settings)
                .sort()
                .map((name) => (
                  <li
                    key={name}
                    className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-body-medium"
                  >
                    <code className="font-mono text-on-surface-variant">{name}</code>
                    <strong className="text-on-surface">
                      {showValue(restore.settings[name] ?? null)}
                    </strong>
                  </li>
                ))
            )}
          </ul>
        ) : null}
        <label htmlFor="restore-reason" className="mt-5 block text-title-small text-on-surface">
          Why are you restoring it?
        </label>
        <textarea
          id="restore-reason"
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

/** A group name as an id: lowercase, and nothing a space can break. */
function groupId(group: string): string {
  return `group-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-body-small text-on-surface-variant">{label}</div>
      <div className="mt-0.5 text-title-small text-on-surface">{value}</div>
    </div>
  );
}
