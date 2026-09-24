import type { FeatureFlagsDocument, FeatureFlagsHistory, SettingRow } from '@pen/contracts';
import { choiceMatrix, FEATURES, ruleMatrix, SETTINGS } from '@pen/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from '../src/App.js';
import { AdminApi } from '../src/lib/api.js';

/**
 * The Features console, driven through its own screen against a scripted
 * API (ADR-0036). What is proved: the matrix says what each plan gets on each
 * platform, a click on a cell or a header changes what resolves before it is
 * saved, a save carries a reason and the whole document, and a conflict keeps
 * the draft.
 */

afterEach(cleanup);

function flag(name: 'ask_questions' | 'google_sign_in') {
  const def = FEATURES[name];
  return {
    name,
    label: def.label,
    description: def.description,
    group: def.group,
    defaultRule: def.rule,
    storedRule: null,
    effectiveRule: def.rule,
    matrix: ruleMatrix(def.rule),
  };
}

function voiceEngine(): SettingRow {
  const def = SETTINGS.voice_engine;
  return {
    name: 'voice_engine',
    label: def.label,
    description: def.description,
    group: def.group,
    values: [...def.values],
    valueLabels: { ...def.valueLabels },
    defaultRule: def.rule,
    storedRule: null,
    effectiveRule: def.rule,
    matrix: choiceMatrix(def.rule),
  };
}

const DOC: FeatureFlagsDocument = {
  revision: 2,
  updatedAt: 1_700_000_000_000,
  updatedBy: 'p_admin',
  updatedByName: 'Sam Owner',
  stale: false,
  features: [flag('ask_questions'), flag('google_sign_in')],
  settings: [voiceEngine()],
};

const HISTORY: FeatureFlagsHistory = {
  entries: [
    {
      revision: 2,
      updatedAt: 1_700_000_000_000,
      updatedBy: 'p_admin',
      updatedByName: 'Sam Owner',
      reason: 'the launch week',
      restoredFromRevision: null,
      rules: { ask_questions: { default: true, plans: {}, platforms: {}, cells: {} } },
      settings: {},
    },
    {
      revision: 1,
      updatedAt: 1_699_000_000_000,
      updatedBy: 'p_admin',
      updatedByName: 'Sam Owner',
      reason: 'hearing Fish for the pros first',
      restoredFromRevision: null,
      rules: {},
      settings: {
        voice_engine: {
          default: 'cartesia',
          plans: { professional: 'fish' },
          platforms: {},
          cells: {},
          participants: { p_owner01: 'fish' },
        },
      },
    },
  ],
  nextBeforeRevision: null,
};

interface Script {
  onSave?: (body: unknown) => { status: number; body: unknown };
}

function scriptedFetch(script: Script, saves: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/api/admin/session'))
      return reply(200, { admin: true, id: 'p_1', name: 'Sam', email: 's@p.test' });
    if (url.includes('/api/admin/features/history')) return reply(200, HISTORY);
    if (url.endsWith('/api/admin/features')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        saves.push(body);
        const answer = script.onSave?.(body) ?? {
          status: 200,
          body: { ...DOC, revision: DOC.revision + 1 },
        };
        return reply(answer.status, answer.body);
      }
      return reply(200, DOC);
    }
    return reply(404, { error: 'NOT_FOUND' });
  });
}

function mount(script: Script = {}) {
  const saves: unknown[] = [];
  vi.stubGlobal('fetch', scriptedFetch(script, saves));
  render(
    <MemoryRouter initialEntries={['/features']}>
      <AdminApp api={new AdminApi()} />
    </MemoryRouter>,
  );
  return { saves };
}

describe('the features screen', () => {
  it('draws each feature as a matrix that says what each plan gets on each platform', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Answer questions' })).toBeTruthy();
    const freeWeb = screen.getByTestId('feature-ask_questions-cell-free-web');
    expect(freeWeb.getAttribute('aria-checked')).toBe('false');
    const standardWeb = screen.getByTestId('feature-ask_questions-cell-standard-web');
    expect(standardWeb.getAttribute('aria-checked')).toBe('true');
    // Google is off on the desktop by the built-in rule, and the cell says so.
    expect(
      screen
        .getByTestId('feature-google_sign_in-cell-free-desktop-mac')
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByTestId('features-overview').textContent).toContain('2');
  });

  it('a click on a cell, a plan or a platform changes what resolves before anything is saved', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Answer questions' });
    // The cell: nothing → on.
    fireEvent.click(screen.getByTestId('feature-ask_questions-cell-free-web'));
    expect(
      screen.getByTestId('feature-ask_questions-cell-free-web').getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByTestId('feature-ask_questions-cell-free-ios').getAttribute('aria-checked'),
    ).toBe('false');
    // The plan head: nothing → on, for every platform of that plan.
    fireEvent.click(screen.getByTestId('feature-ask_questions-plan-free'));
    expect(
      screen.getByTestId('feature-ask_questions-cell-free-ios').getAttribute('aria-checked'),
    ).toBe('true');
    // The platform head: on → off → nothing; off ANDs with the plan's on.
    fireEvent.click(screen.getByTestId('feature-ask_questions-platform-ios'));
    fireEvent.click(screen.getByTestId('feature-ask_questions-platform-ios'));
    expect(
      screen.getByTestId('feature-ask_questions-cell-free-ios').getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByTestId('feature-ask_questions-cell-standard-ios').getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByTestId('feature-ask_questions').textContent).toContain('Unsaved');
  });

  it('will not save without a reason, and sends the whole document with untouched rules as null', async () => {
    const { saves } = mount();
    await screen.findByRole('heading', { name: 'Answer questions' });
    const save = screen.getByTestId('save-features') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('feature-ask_questions-plan-free'));
    expect((screen.getByTestId('save-features') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('features-save-reason'), {
      target: { value: 'launch week' },
    });
    fireEvent.click(screen.getByTestId('save-features'));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({
      expectedRevision: 2,
      reason: 'launch week',
      rules: {
        ask_questions: {
          default: false,
          plans: { free: true, standard: true, professional: true },
          platforms: {},
          cells: {},
          anonymous: false,
        },
        google_sign_in: null,
      },
      settings: { voice_engine: null },
    });
    expect(await screen.findByTestId('features-notice')).toBeTruthy();
  });

  it('draws the voice engine as a matrix of values, and a plan’s answer shows in its cells', async () => {
    const { saves } = mount();
    await screen.findByRole('heading', { name: 'Voice engine' });
    const cell = screen.getByTestId(
      'setting-voice_engine-cell-professional-web',
    ) as HTMLSelectElement;
    expect(cell.value).toBe('');
    expect(cell.getAttribute('data-resolved')).toBe('cartesia');
    fireEvent.change(screen.getByTestId('setting-voice_engine-plan-professional'), {
      target: { value: 'fish' },
    });
    expect(
      (
        screen.getByTestId('setting-voice_engine-cell-professional-web') as HTMLSelectElement
      ).getAttribute('data-resolved'),
    ).toBe('fish');
    expect(
      (screen.getByTestId('setting-voice_engine-cell-free-web') as HTMLSelectElement).getAttribute(
        'data-resolved',
      ),
    ).toBe('cartesia');
    expect(screen.getByTestId('setting-voice_engine').textContent).toContain('Unsaved');
    fireEvent.change(screen.getByTestId('features-save-reason'), {
      target: { value: 'pros hear Fish' },
    });
    fireEvent.click(screen.getByTestId('save-features'));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect((saves[0] as { settings: unknown }).settings).toEqual({
      voice_engine: {
        default: 'cartesia',
        plans: { professional: 'fish' },
        platforms: {},
        cells: {},
        participants: {},
      },
    });
    expect((saves[0] as { rules: Record<string, unknown> }).rules).toEqual({
      ask_questions: null,
      google_sign_in: null,
    });
  });

  it('adds and removes an answer for one account, and only a real id can be added', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Voice engine' });
    const add = screen.getByTestId('setting-voice_engine-participant-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('setting-voice_engine-participant-id'), {
      target: { value: 'not an id' },
    });
    expect(
      (screen.getByTestId('setting-voice_engine-participant-add') as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId('setting-voice_engine-participant-id'), {
      target: { value: 'p_owner01' },
    });
    fireEvent.change(screen.getByTestId('setting-voice_engine-participant-value'), {
      target: { value: 'fish' },
    });
    fireEvent.click(screen.getByTestId('setting-voice_engine-participant-add'));
    const row = screen.getByTestId('setting-voice_engine-participant-p_owner01');
    expect(row.textContent).toContain('p_owner01');
    expect((row.querySelector('select') as HTMLSelectElement).value).toBe('fish');
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove the answer for account p_owner01' }),
    );
    expect(screen.queryByTestId('setting-voice_engine-participant-p_owner01')).toBeNull();
    expect(screen.getByTestId('setting-voice_engine').textContent).not.toContain('Unsaved');
  });

  it('lists a setting in the history and in the restore dialog', async () => {
    mount();
    const entry = await screen.findByTestId('features-revision-1');
    expect(entry.textContent).toContain('Voice engine');
    expect(entry.textContent).toContain('Cartesia by default');
    expect(entry.textContent).toContain('Fish Audio for Professional');
    expect(entry.textContent).toContain('1 account');
    fireEvent.click(screen.getByRole('button', { name: 'Restore feature revision 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Voice engine');
    expect(dialog.textContent).toContain('Fish Audio for Professional');
  });

  it('keeps the draft and says what to do when somebody else saved first', async () => {
    mount({
      onSave: () => ({
        status: 409,
        body: { error: 'CONFLICT', message: 'changed', current: 7 },
      }),
    });
    await screen.findByRole('heading', { name: 'Answer questions' });
    fireEvent.click(screen.getByTestId('feature-ask_questions-plan-free'));
    fireEvent.change(screen.getByTestId('features-save-reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('save-features'));
    const alert = await screen.findByTestId('features-error');
    expect(alert.textContent).toContain('Someone else saved');
    expect(alert.textContent).toContain('Your draft is kept');
    expect(
      screen.getByTestId('feature-ask_questions-cell-free-web').getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('shows the history in the learner’s words', async () => {
    mount();
    const entry = await screen.findByTestId('features-revision-2');
    expect(entry.textContent).toContain('the launch week');
    expect(entry.textContent).toContain('Answer questions');
    expect(entry.textContent).toContain('default on');
  });
});
