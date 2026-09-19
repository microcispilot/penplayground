import type { RuntimeConfigDocument, RuntimeConfigHistory } from '@pen/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from '../src/App.js';
import { AdminApi } from '../src/lib/api.js';

/**
 * The console, driven through its own screen against a scripted API
 * (ADR-0026). What is proved here is what an operator sees: the default
 * beside the value, a pin they cannot override from the browser, a save that
 * carries a reason, and a conflict that keeps their work.
 */

afterEach(cleanup);

const DOC: RuntimeConfigDocument = {
  revision: 3,
  updatedAt: 1_700_000_000_000,
  updatedBy: 'p_admin',
  updatedByName: 'Sam Owner',
  stale: false,
  settings: [
    {
      name: 'PEN_INTENT_PROVIDER',
      env: 'PEN_INTENT_PROVIDER',
      label: 'Intent provider',
      description: 'Who classifies a turn the heuristics cannot place.',
      group: 'Thinking',
      kind: 'choice',
      scope: 'session',
      options: ['model', 'jev'],
      defaultValue: 'jev',
      storedValue: null,
      effectiveValue: 'jev',
      source: 'default',
      pinnedByEnv: false,
    },
    {
      name: 'PEN_TTS_PROVIDER',
      env: 'PEN_TTS_PROVIDER',
      label: 'Voice provider',
      description: 'Which synthesis engine speaks.',
      group: 'Voice',
      kind: 'choice',
      scope: 'restart',
      options: ['fish-cloud', 'fish-bridge', 'silent'],
      defaultValue: 'fish-cloud',
      storedValue: null,
      effectiveValue: 'silent',
      source: 'env',
      pinnedByEnv: true,
    },
  ],
};

const HISTORY: RuntimeConfigHistory = {
  entries: [
    {
      revision: 3,
      updatedAt: 1_700_000_000_000,
      updatedBy: 'p_admin',
      updatedByName: 'Sam Owner',
      reason: 'Sharper cards for the launch page',
      restoredFromRevision: null,
      settings: { PEN_THUMBNAIL_QUALITY: 'high' },
    },
    {
      revision: 2,
      updatedAt: 1_699_000_000_000,
      updatedBy: 'p_admin',
      updatedByName: 'Sam Owner',
      reason: 'the cadence we liked',
      restoredFromRevision: null,
      settings: { PEN_ADS_EVERY_SEGMENTS: 6 },
    },
  ],
  nextBeforeRevision: null,
};

interface Script {
  session?: unknown;
  doc?: RuntimeConfigDocument;
  history?: RuntimeConfigHistory;
  /** What a PUT answers with: a document, or a failure to throw. */
  onSave?: (body: unknown) => { status: number; body: unknown };
  /** What a rollback answers with. */
  onRollback?: (body: unknown) => { status: number; body: unknown };
}

/** A fetch that answers only the console's four routes, and records the saves. */
function scriptedFetch(script: Script, saves: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/api/admin/session'))
      return reply(
        200,
        script.session ?? { admin: true, id: 'p_1', name: 'Sam', email: 's@p.test' },
      );
    if (url.includes('/api/admin/runtime-config/history'))
      return reply(200, script.history ?? HISTORY);
    if (url.endsWith('/api/admin/runtime-config/rollback')) {
      const body = JSON.parse(String(init?.body));
      saves.push(body);
      const answer = script.onRollback?.(body) ?? {
        status: 200,
        body: { ...DOC, revision: DOC.revision + 1 },
      };
      return reply(answer.status, answer.body);
    }
    if (url.endsWith('/api/admin/runtime-config')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        saves.push(body);
        const answer = script.onSave?.(body) ?? {
          status: 200,
          body: { ...DOC, revision: DOC.revision + 1 },
        };
        return reply(answer.status, answer.body);
      }
      return reply(200, script.doc ?? DOC);
    }
    return reply(404, { error: 'NOT_FOUND' });
  });
}

function mount(script: Script = {}) {
  const saves: unknown[] = [];
  vi.stubGlobal('fetch', scriptedFetch(script, saves));
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AdminApp api={new AdminApi()} />
    </MemoryRouter>,
  );
  return { saves };
}

describe('the settings screen', () => {
  it('shows each setting beside its default and what is in force', async () => {
    mount();
    expect(await screen.findByText('Intent provider')).toBeTruthy();
    const row = screen.getByTestId('setting-PEN_INTENT_PROVIDER');
    expect(row.textContent).toContain('PEN_INTENT_PROVIDER');
    expect(row.textContent).toContain('Default');
    expect(row.textContent).toContain('In force now');
    expect(row.textContent).toContain('Takes effect on the next lesson');
    // The revision in force is stated, not implied.
    expect(screen.getByTestId('settings-overview').textContent).toContain('3');
  });

  it('says plainly when this server pins a setting, and that a restart is needed for it', async () => {
    mount();
    const row = await screen.findByTestId('setting-PEN_TTS_PROVIDER');
    expect(row.textContent).toContain('Pinned on this server');
    expect(row.textContent).toContain('Takes effect after the API restarts');
    // The value it is actually running on, not the one that is saved.
    expect(row.textContent).toContain('silent');
  });

  it('says what this server would run after a save, and that a pin will still win', async () => {
    mount();
    await screen.findByText('Intent provider');

    fireEvent.change(screen.getByLabelText('Intent provider'), { target: { value: 'model' } });
    expect(screen.getByTestId('setting-PEN_INTENT_PROVIDER').textContent).toContain(
      'After saving · model',
    );

    // The same edit on a pinned setting: the save is for the other servers,
    // and the row says so rather than implying this one will follow.
    fireEvent.change(screen.getByLabelText('Voice provider'), {
      target: { value: 'fish-bridge' },
    });
    // Saved as fish-bridge for everyone else; this box keeps running on the
    // value its environment pins, and the row says that and not the draft.
    expect(screen.getByTestId('setting-PEN_TTS_PROVIDER').textContent).toContain(
      'After saving · silent',
    );
    expect(screen.getByTestId('setting-PEN_TTS_PROVIDER').textContent).not.toContain(
      'After saving · fish-bridge',
    );
    expect(screen.getByTestId('setting-PEN_TTS_PROVIDER').textContent).toContain(
      'Pinned on this server',
    );
  });

  it('will not save without a reason, and sends the whole document when it does', async () => {
    const { saves } = mount();
    await screen.findByText('Intent provider');
    const save = screen.getByTestId('save-settings') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Intent provider'), { target: { value: 'model' } });
    // Changed, but still no reason.
    expect((screen.getByTestId('save-settings') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('save-reason'), {
      target: { value: 'Trying the session model for a week.' },
    });
    expect((screen.getByTestId('save-settings') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      expectedRevision: 3,
      reason: 'Trying the session model for a week.',
      settings: { PEN_INTENT_PROVIDER: 'model', PEN_TTS_PROVIDER: null },
    });
  });

  it('keeps the draft and says what to do when somebody else saved first', async () => {
    mount({
      onSave: () => ({ status: 409, body: { error: 'CONFLICT', message: 'changed', current: 4 } }),
    });
    await screen.findByText('Intent provider');
    fireEvent.change(screen.getByLabelText('Intent provider'), { target: { value: 'model' } });
    fireEvent.change(screen.getByTestId('save-reason'), { target: { value: 'a change' } });
    fireEvent.click(screen.getByTestId('save-settings'));

    const error = await screen.findByTestId('settings-error');
    // The 409 branch specifically, not the unknown-error fallback that also
    // says "reload": the server told us which revision won, and the operator
    // needs that number.
    expect(error.textContent).toContain('Someone else saved while you were editing');
    expect(error.textContent).toContain('the current revision is 4');
    expect(error.textContent).toContain('Your draft is kept');
    // The edit is still on screen, and cannot be saved over the other one.
    expect((screen.getByLabelText('Intent provider') as HTMLSelectElement).value).toBe('model');
    expect((screen.getByTestId('save-settings') as HTMLButtonElement).disabled).toBe(true);
  });

  it('restores an old revision as a new one, with its own reason', async () => {
    const { saves } = mount();
    const entry = await screen.findByTestId('revision-2');
    fireEvent.click(entry.querySelector('summary') as HTMLElement);
    fireEvent.click(screen.getByLabelText('Restore revision 2'));
    // The dialog shows what that revision held, and will not go without a why.
    expect(await screen.findByText('Restore revision 2')).toBeTruthy();
    const restore = screen.getByRole('button', { name: 'Restore as a new revision' });
    expect((restore as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why are you restoring it?'), {
      target: { value: 'the cadence was wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore as a new revision' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({
      expectedRevision: 3,
      targetRevision: 2,
      reason: 'the cadence was wrong',
    });
  });

  it('shows the history with who changed what and why', async () => {
    mount();
    const entry = await screen.findByTestId('revision-3');
    expect(entry.textContent).toContain('Sam Owner');
    expect(entry.textContent).toContain('Sharper cards for the launch page');
  });

  it('sends a signed-in account that is not an operator back to the sign-in screen', async () => {
    mount({ session: { admin: false } });
    await waitFor(() => expect(screen.getByTestId('google-signin')).toBeTruthy());
    expect(screen.queryByText('Intent provider')).toBeNull();
  });
});
