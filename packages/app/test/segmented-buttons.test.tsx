import { SegmentedButtons } from '@pen/design';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const OPTIONS = [
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly · 2 months free' },
  { value: 'life', label: 'Lifetime' },
] as const;

function renderGroup(value: 'month' | 'year' | 'life' = 'month') {
  const onChange = vi.fn();
  render(
    <SegmentedButtons label="Billing period" options={OPTIONS} value={value} onChange={onChange} />,
  );
  return onChange;
}

/**
 * M3's segmented button answers one question, so it is one radio group — and a
 * radio group owes the keyboard a contract: a single Tab stop, arrows that
 * move *and* choose, Home and End for the ends. `role="radio"` without that
 * is a promise the component does not keep, which is why it is pinned here
 * rather than left to a screenshot.
 */
describe('SegmentedButtons', () => {
  it('is one radio group with one radio per answer', () => {
    renderGroup();
    const group = screen.getByRole('radiogroup', { name: 'Billing period' });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('marks the chosen answer, and only that one', () => {
    renderGroup('year');
    const chosen = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-checked'));
    expect(chosen).toEqual(['false', 'true', 'false']);
  });

  it('is a single Tab stop: only the chosen segment is reachable by Tab', () => {
    renderGroup('year');
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('falls back to the first segment when the value matches none of them', () => {
    render(
      <SegmentedButtons
        label="Billing period"
        options={OPTIONS}
        value={'never' as 'month'}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('a click chooses', () => {
    const onChange = renderGroup();
    fireEvent.click(screen.getByRole('radio', { name: /Lifetime/ }));
    expect(onChange).toHaveBeenCalledWith('life');
  });

  it.each([
    ['ArrowRight', 'year'],
    ['ArrowDown', 'year'],
    ['ArrowLeft', 'life'],
    ['ArrowUp', 'life'],
    ['End', 'life'],
    ['Home', 'month'],
  ])('%s from the first segment chooses %s', (key, expected) => {
    const onChange = renderGroup();
    fireEvent.keyDown(screen.getByRole('radio', { name: /Monthly/ }), { key });
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('wraps at both ends, the way a radio group does', () => {
    const onChange = renderGroup('life');
    fireEvent.keyDown(screen.getByRole('radio', { name: /Lifetime/ }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('month');
  });

  it('leaves keys it does not own to the page', () => {
    const onChange = renderGroup();
    fireEvent.keyDown(screen.getByRole('radio', { name: /Monthly/ }), { key: 'Tab' });
    fireEvent.keyDown(screen.getByRole('radio', { name: /Monthly/ }), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
