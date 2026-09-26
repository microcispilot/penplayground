import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Pricing } from '../src/screens/Pricing.js';
import { ANONYMOUS, renderWithApp } from './harness.js';

afterEach(cleanup);

const routes = { '/api/billing/status': { enabled: true } };

/**
 * The pricing page, as the owner set it on 2026-09-25 (ADR-0056): Standard
 * 29, Professional 49, a year at ten months; and a voice that is
 * professional, shows none of the machinery, and uses no dash as
 * punctuation. "Share with friends" is the owner's phrase for what leaves
 * the product.
 */
describe('the pricing page', () => {
  it('shows $0, $29 and $49 a month, and $24 and $41 a month when billed yearly', async () => {
    renderWithApp(<Pricing />, { participant: ANONYMOUS, routes });
    await waitFor(() => screen.getByRole('button', { name: 'Get Standard' }));
    const amounts = () =>
      Array.from(document.querySelectorAll('.font-display')).map((el) => el.textContent);
    expect(amounts()).toEqual(['$0', '$29', '$49']);
    fireEvent.click(screen.getByRole('radio', { name: /Yearly/ }));
    expect(amounts()).toEqual(['$0', '$24', '$41']);
    expect(screen.getAllByText(/billed yearly/).length).toBe(3);
  });

  it('speaks in the product voice: no dashes, no machinery, and "share with friends"', async () => {
    renderWithApp(<Pricing />, { participant: ANONYMOUS, routes });
    await waitFor(() => screen.getByRole('button', { name: 'Get Standard' }));
    const text = document.body.textContent ?? '';
    // No em or en dash anywhere on the page.
    expect(text).not.toMatch(/[\u2013\u2014]/);
    // Nothing about how a lesson is made, only what the learner gets.
    for (const internal of ['prepared', 'nobody', 'cheap', 'trial']) {
      expect(text.toLowerCase(), internal).not.toContain(internal);
    }
    expect(text).toContain('share it with friends');
  });
});
