import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from '../src/App.js';
import { AdminApi } from '../src/lib/api.js';
import { dayLabel } from '../src/lib/format.js';
import {
  AbandonmentReport,
  ClockPayload,
  CostPayload,
  DevicesPayload,
  GeographyPayload,
  OverviewPayload,
  PlansPayload,
  RetentionPayload,
  SessionDetail,
  SessionsPayload,
  StagesPayload,
  UsersPayload,
  VisitsPayload,
} from '../src/lib/stats-schemas.js';
import { buildFixture, type Mode, sessionDetailFixture } from './fixtures/reports.js';

/**
 * The statistics section, driven through its own screens against a scripted
 * reporting API (ADR-0027).
 *
 * Two things are proved here, and the second is the one that keeps the first
 * honest:
 *
 *   1. every page renders what it was given — the headline numbers, the
 *      reuse searches, the honest "Not available" in the geography table —
 *      and renders a considered page when every number is zero;
 *   2. the fixture those pages are given still matches the schemas the
 *      console parses a *real* answer with, which means the shapes asserted
 *      below are the shapes `routes.ts` actually returns rather than a
 *      convenient invention.
 */

afterEach(cleanup);

const NOW = Date.UTC(2026, 8, 19, 12, 0);

function scriptedFetch(mode: Mode) {
  const fixture = buildFixture(mode, NOW);
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push(url);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/api/admin/session'))
      return reply(200, { admin: true, id: 'p_1', name: 'Sam', email: 's@p.test' });
    const match = /\/api\/admin\/stats\/([^?]+)/.exec(url);
    if (match?.[1]) {
      const path = match[1];
      if (path.startsWith('sessions/')) return reply(200, sessionDetailFixture(path.slice(9), NOW));
      const body = fixture.reports[path];
      if (body !== undefined) return reply(200, body);
    }
    return reply(404, { error: 'NOT_FOUND' });
  });
  return { fetcher, calls, fixture };
}

function mount(path: string, mode: Mode = 'full') {
  const scripted = scriptedFetch(mode);
  vi.stubGlobal('fetch', scripted.fetcher);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AdminApp api={new AdminApi()} />
    </MemoryRouter>,
  );
  return scripted;
}

describe('the fixture is the shape the API really answers with', () => {
  // If this fails, every assertion below is testing a payload the server
  // does not send. It is first on purpose.
  it('parses under the console’s own schemas', () => {
    for (const mode of ['full', 'empty'] as const) {
      const { reports } = buildFixture(mode, NOW);
      const pairs = [
        [OverviewPayload, 'overview'],
        [CostPayload, 'cost'],
        [StagesPayload, 'stages'],
        [AbandonmentReport, 'abandonment'],
        [RetentionPayload, 'retention'],
        [SessionsPayload, 'sessions'],
        [UsersPayload, 'users'],
        [VisitsPayload, 'visits'],
        [GeographyPayload, 'geography'],
        [DevicesPayload, 'devices'],
        [ClockPayload, 'clock'],
        [PlansPayload, 'plans'],
      ] as const;
      for (const [schema, path] of pairs) {
        const parsed = schema.safeParse(reports[path]);
        expect(
          parsed.success,
          `${mode}/${path}: ${JSON.stringify(parsed.error?.issues ?? [])}`,
        ).toBe(true);
      }
    }
    expect(SessionDetail.safeParse(sessionDetailFixture('s_x', NOW)).success).toBe(true);
  });
});

describe('the statistics section', () => {
  it('is reachable from the console nav and no longer says “soon”', async () => {
    mount('/settings');
    const nav = await screen.findByTestId('admin-nav');
    expect(within(nav).getByRole('link', { name: 'Statistics' })).toBeTruthy();
    expect(nav.textContent).not.toContain('Soon');
  });

  it('opens on the overview with the headline numbers', async () => {
    mount('/statistics');
    await screen.findAllByTestId('report-body');
    expect(screen.getByText('Lessons taught')).toBeTruthy();
    // 30 days of sessions, summed by the fixture.
    const tiles = screen.getAllByTestId('stat-tiles')[0];
    expect(tiles?.textContent).toContain('Reached the recap');
    expect(tiles?.textContent).toContain('Spent');
  });

  it('asks every endpoint for the same window, and for the API’s own default', async () => {
    const { calls } = mount('/statistics');
    await screen.findAllByTestId('report-body');
    const windows = new Set<string>();
    for (const call of calls) {
      const url = new URL(call, 'http://console.test');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (from && to) windows.add(`${Number(to) - Number(from)}|${url.searchParams.get('bucket')}`);
    }
    // One window, thirty days, by day — `DEFAULT_WINDOW_MS` in routes.ts.
    expect([...windows]).toEqual([`${30 * 86_400_000}|day`]);
  });

  it('carries the range through the URL when a preset is chosen', async () => {
    // The range resolves against the real clock, so the expectation is
    // computed the same way rather than hard-coded to a date this test
    // would stop being true on.
    const now = Date.now();
    mount('/statistics?range=7d');
    await screen.findAllByTestId('report-body');
    const summary = screen.getByTestId('range-summary');
    expect(summary.textContent).toContain(dayLabel(now - 7 * 86_400_000));
    expect(summary.textContent).toContain(dayLabel(now - 1));
    expect(screen.getByTestId('range-7d').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the seven pages as tabs', async () => {
    mount('/statistics');
    const tabs = await screen.findByTestId('statistics-tabs');
    for (const label of [
      'Overview',
      'Money',
      'Sessions',
      'Pipeline',
      'People',
      'Visits',
      'Audience',
    ])
      expect(within(tabs).getByRole('link', { name: label })).toBeTruthy();
  });
});

describe('each page renders what it was given', () => {
  it('Money shows spend, the component split and the subscription mix', async () => {
    mount('/statistics/money');
    await screen.findAllByTestId('report-body');
    expect(screen.getByText('Where the money goes')).toBeTruthy();
    // The engine that spoke is a breakdown of its own (ADR-0048).
    expect(screen.getByText('By voice engine')).toBeTruthy();
    expect(screen.getByText('Cartesia')).toBeTruthy();
    expect(screen.getByText('Fish Audio')).toBeTruthy();
    expect(screen.getByText('Subscriptions')).toBeTruthy();
    // The owner asked for the monthly/yearly split by name.
    expect(screen.getAllByText(/Personal, yearly/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Personal, monthly/).length).toBeGreaterThan(0);
  });

  it('Sessions lists lessons with their replays and shares', async () => {
    mount('/statistics/sessions');
    await screen.findAllByTestId('report-body');
    expect(screen.getByRole('columnheader', { name: 'Replays' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Shares' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Photosynthesis/ })).toBeTruthy();
  });

  it('a session says how often it was reused and for which searches', async () => {
    mount('/statistics/sessions/s_photosynthesis');
    await screen.findAllByTestId('report-body');
    const searches = await screen.findByTestId('reuse-searches');
    expect(searches.textContent).toContain('why are leaves green');
    expect(searches.textContent).toContain('calvin cycle step by step');
    expect(screen.getByText(/Reused by/)).toBeTruthy();
    // And the two other per-session counters the owner named.
    expect(screen.getByText('Replays')).toBeTruthy();
    expect(screen.getByText('Shares')).toBeTruthy();
  });

  it('Pipeline shows the stages, the error codes and why lessons stopped', async () => {
    mount('/statistics/pipeline');
    await screen.findAllByTestId('report-body');
    // "Speech out" is the `tts` stage, named both in the stage table and
    // beside the error code that happened in it.
    expect(screen.getAllByText('Speech out').length).toBeGreaterThan(0);
    expect(screen.getByText('TTS_TIMEOUT')).toBeTruthy();
    expect(screen.getByText('Stopped part-way through')).toBeTruthy();
    expect(screen.getByText('Where they stopped')).toBeTruthy();
  });

  it('People shows a cohort grid and the per-person averages', async () => {
    mount('/statistics/people');
    await screen.findAllByTestId('report-body');
    expect(screen.getByText('Retention')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Per lesson' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ada Okafor' })).toBeTruthy();
  });

  it('Visits separates signed-in from anonymous and prints the active-time definition', async () => {
    mount('/statistics/visits');
    await screen.findAllByTestId('report-body');
    expect(screen.getByText(/Engaged time: the page was visible/)).toBeTruthy();
    expect(screen.getAllByText('Not signed in').length).toBeGreaterThan(0);
    expect(screen.getByText('Typed or bookmarked')).toBeTruthy();
  });

  it('Audience says out loud that region and city are not available', async () => {
    mount('/statistics/audience');
    await screen.findAllByTestId('report-body');
    // The server's own note, printed verbatim rather than paraphrased.
    expect(screen.getByText(/no geo-IP is configured/)).toBeTruthy();
    // The rows are kept and the cells say why they are empty, rather than
    // the columns being hidden.
    expect(screen.getByRole('columnheader', { name: 'Region' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'City' })).toBeTruthy();
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('United States')).toBeTruthy();
  });
});

describe('a deployment with no data yet', () => {
  it.each([
    ['/statistics', 'No lessons finished in this window yet.'],
    ['/statistics/money', 'No lessons finished in this window, so nothing was spent.'],
    ['/statistics/sessions', /No lesson in this window matches/],
    ['/statistics/pipeline', /No lesson in this window recorded a stage/],
    ['/statistics/people', /No cohort has formed in this window yet/],
    ['/statistics/visits', /Nobody has been counted in this window/],
    ['/statistics/audience', 'No visit in this window recorded a country.'],
  ])('%s explains the emptiness rather than looking broken', async (path, expected) => {
    mount(path, 'empty');
    await screen.findAllByTestId('report-body');
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    // And no page reports zero as a failure.
    expect(screen.queryByTestId('report-error')).toBeNull();
  });

  it('still prints zero as a number rather than as a gap', async () => {
    mount('/statistics', 'empty');
    await screen.findAllByTestId('report-body');
    const tiles = screen.getAllByTestId('stat-tiles')[0];
    expect(tiles?.textContent).toContain('$0.00');
    expect(tiles?.textContent).toContain('0%');
  });
});

describe('when a report cannot be read', () => {
  it('says so and offers to try again, instead of an empty page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url.includes('/api/admin/session'))
          return new Response(JSON.stringify({ admin: true, id: 'p', name: 'S', email: 'a@b.c' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        return new Response(JSON.stringify({ error: 'BOOM', message: 'The database is away.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/statistics']}>
        <AdminApp api={new AdminApi()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('report-error')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
