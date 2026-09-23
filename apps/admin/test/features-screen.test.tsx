import type { FeatureFlagsDocument, FeatureFlagsHistory } from '@pen/contracts';
import { FEATURES, ruleMatrix } from '@pen/contracts';
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

function flag(name: 'prepare_new_topics' | 'google_sign_in') {
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

const DOC: FeatureFlagsDocument = {
  revision: 2,
  updatedAt: 1_700_000_000_000,
  updatedBy: 'p_admin',
  updatedByName: 'Sam Owner',
  stale: false,
  features: [flag('prepare_new_topics'), flag('google_sign_in')],
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
      rules: { prepare_new_topics: { default: true, plans: {}, platforms: {}, cells: {} } },
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
    expect(await screen.findByRole('heading', { name: 'Prepare new topics' })).toBeTruthy();
    const freeWeb = screen.getByTestId('feature-prepare_new_topics-cell-free-web');
    expect(freeWeb.getAttribute('aria-checked')).toBe('false');
    const standardWeb = screen.getByTestId('feature-prepare_new_topics-cell-standard-web');
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
    await screen.findByRole('heading', { name: 'Prepare new topics' });
    // The cell: nothing → on.
    fireEvent.click(screen.getByTestId('feature-prepare_new_topics-cell-free-web'));
    expect(
      screen.getByTestId('feature-prepare_new_topics-cell-free-web').getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByTestId('feature-prepare_new_topics-cell-free-ios').getAttribute('aria-checked'),
    ).toBe('false');
    // The plan head: nothing → on, for every platform of that plan.
    fireEvent.click(screen.getByTestId('feature-prepare_new_topics-plan-free'));
    expect(
      screen.getByTestId('feature-prepare_new_topics-cell-free-ios').getAttribute('aria-checked'),
    ).toBe('true');
    // The platform head: on → off → nothing; off ANDs with the plan's on.
    fireEvent.click(screen.getByTestId('feature-prepare_new_topics-platform-ios'));
    fireEvent.click(screen.getByTestId('feature-prepare_new_topics-platform-ios'));
    expect(
      screen.getByTestId('feature-prepare_new_topics-cell-free-ios').getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen
        .getByTestId('feature-prepare_new_topics-cell-standard-ios')
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByTestId('feature-prepare_new_topics').textContent).toContain('Unsaved');
  });

  it('will not save without a reason, and sends the whole document with untouched rules as null', async () => {
    const { saves } = mount();
    await screen.findByRole('heading', { name: 'Prepare new topics' });
    const save = screen.getByTestId('save-features') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('feature-prepare_new_topics-plan-free'));
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
        prepare_new_topics: {
          default: false,
          plans: { free: true, standard: true, professional: true },
          platforms: {},
          cells: {},
        },
        google_sign_in: null,
      },
    });
    expect(await screen.findByTestId('features-notice')).toBeTruthy();
  });

  it('keeps the draft and says what to do when somebody else saved first', async () => {
    mount({
      onSave: () => ({
        status: 409,
        body: { error: 'CONFLICT', message: 'changed', current: 7 },
      }),
    });
    await screen.findByRole('heading', { name: 'Prepare new topics' });
    fireEvent.click(screen.getByTestId('feature-prepare_new_topics-plan-free'));
    fireEvent.change(screen.getByTestId('features-save-reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('save-features'));
    const alert = await screen.findByTestId('features-error');
    expect(alert.textContent).toContain('Someone else saved');
    expect(alert.textContent).toContain('Your draft is kept');
    expect(
      screen.getByTestId('feature-prepare_new_topics-cell-free-web').getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('shows the history in the learner’s words', async () => {
    mount();
    const entry = await screen.findByTestId('features-revision-2');
    expect(entry.textContent).toContain('the launch week');
    expect(entry.textContent).toContain('Prepare new topics');
    expect(entry.textContent).toContain('default on');
  });
});
