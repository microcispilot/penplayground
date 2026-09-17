import { describe, expect, it } from 'vitest';
import { bootMode } from '../src/lib/boot.js';

describe('bootMode', () => {
  it('is headless-render only for /replay/:id?export=1', () => {
    expect(bootMode({ pathname: '/replay/s_abc123', search: '?export=1' })).toBe('headless-render');
    expect(bootMode({ pathname: '/replay/s_abc123/', search: '?export=1&x=2' })).toBe(
      'headless-render',
    );
  });

  it('is the ordinary app everywhere else, even with export in the query', () => {
    expect(bootMode({ pathname: '/replay/s_abc123', search: '' })).toBe('app');
    expect(bootMode({ pathname: '/replay/s_abc123', search: '?export=0' })).toBe('app');
    expect(bootMode({ pathname: '/sessions/s_abc123', search: '?export=1' })).toBe('app');
    expect(bootMode({ pathname: '/', search: '?export=1' })).toBe('app');
    expect(bootMode({ pathname: '/replay', search: '?export=1' })).toBe('app');
  });
});
