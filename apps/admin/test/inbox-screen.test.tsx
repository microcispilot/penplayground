import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from '../src/App.js';
import { AdminApi } from '../src/lib/api.js';

afterEach(cleanup);

const NOW = Date.UTC(2026, 8, 26, 12, 0);
const entry = (id: string, kind: string, status: string, message: string) => ({
  id,
  kind,
  status,
  message,
  email: 'ada@example.com',
  name: 'Ada',
  participantId: 'p_ada',
  participantName: 'Ada',
  participantPlan: 'standard',
  participantAnonymous: false,
  screen: 'room',
  platform: 'web',
  release: 'abc1234def',
  environment: 'staging',
  adminNote: null,
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 3_600_000,
});

/** The inbox (ADR-0060): the list, its counts, the whole message on a click, and a status moved. */
describe('the inbox', () => {
  it('lists submissions with counts, opens one, and resolves it', async () => {
    let feedback = [
      entry('f_1', 'issue', 'new', 'The board stopped drawing after the second segment.'),
      entry('f_2', 'contact', 'seen', 'Do you offer plans for a school of forty students?'),
    ];
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        const reply = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url.includes('/api/admin/session'))
          return reply({ admin: true, id: 'p_1', name: 'Sam', email: 's@p.test' });
        if (/\/api\/admin\/feedback\/f_1$/.test(url) && init?.method === 'PATCH') {
          feedback = feedback.map((f) => (f.id === 'f_1' ? { ...f, status: 'resolved' } : f));
          return reply({ feedback: feedback[0] });
        }
        if (url.includes('/api/admin/feedback')) {
          const counts = { new: 0, seen: 0, resolved: 0 };
          for (const f of feedback) counts[f.status as keyof typeof counts] += 1;
          return reply({ feedback, total: feedback.length, counts });
        }
        return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <AdminApp api={new AdminApi()} />
      </MemoryRouter>,
    );
    await screen.findAllByTestId('report-body');
    expect(screen.getByText('Not yet read')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeTruthy();
    const row = screen.getByTestId('inbox-row-f_1');
    expect(row.textContent).toContain('Report an issue');
    fireEvent.click(row);
    const detail = await screen.findByTestId('inbox-detail-f_1');
    expect(detail.textContent).toContain('ada@example.com');
    expect(detail.textContent).toContain('Sent from room on web, staging (abc1234)');
    fireEvent.click(screen.getByTestId('inbox-resolve-f_1'));
    await waitFor(() =>
      expect(
        calls.some((c) => c.startsWith('PATCH ') && c.includes('/api/admin/feedback/f_1')),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId('inbox-row-f_1').textContent).toContain('resolved'),
    );
  });
});
