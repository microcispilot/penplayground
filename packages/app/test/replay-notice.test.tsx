import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplayNotice } from '../src/components/RoomChrome.js';

afterEach(cleanup);

/**
 * The replay's one status line. A sentence whose audio the browser refuses to
 * start is recovered by timing it off the wall clock
 * (`MEDIA_STALL_TIMEOUT_MS`), which keeps the board and the clock moving but
 * leaves the viewer with silence and no reason for it. This is the reason.
 */
describe('ReplayNotice', () => {
  it('says nothing, and claims no status, when there is nothing to say', () => {
    const { container } = render(<ReplayNotice notice={null} />);
    expect(screen.queryByTestId('status-notice')).toBeNull();
    expect(container.querySelector('[data-status]')?.getAttribute('data-status')).toBe('none');
  });

  it('shows the line as one calm pill in a live region', () => {
    const text = 'Sound is unavailable here — the replay keeps going without it';
    const { container } = render(<ReplayNotice notice={{ text, tone: 'neutral' }} />);
    const pill = screen.getByTestId('status-notice');
    expect(pill.textContent).toBe(text);
    const region = container.querySelector('[data-status="status-notice"]');
    // A screen reader hears the change without being interrupted by it.
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });
});
