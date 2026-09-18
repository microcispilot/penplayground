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

  /**
   * Under a base path the renderer opens `<prefix>/replay/:id?export=1`. Read
   * without the prefix that is not the replay route, the shell boots as the
   * ordinary app, and every MP4 render mints a participant and starts analytics.
   */
  it("reads the route past the app's base path", () => {
    expect(
      bootMode(
        { pathname: '/testingxyzbdc/replay/s_abc123', search: '?export=1' },
        '/testingxyzbdc/',
      ),
    ).toBe('headless-render');
    expect(
      bootMode(
        { pathname: '/testingxyzbdc/replay/s_abc123/', search: '?export=1' },
        '/testingxyzbdc',
      ),
    ).toBe('headless-render');
    // Without the prefix configured, the same URL is not the replay route.
    expect(bootMode({ pathname: '/testingxyzbdc/replay/s_abc123', search: '?export=1' })).toBe(
      'app',
    );
    // And a base path never turns something else into a render.
    expect(
      bootMode(
        { pathname: '/testingxyzbdc/sessions/s_abc123', search: '?export=1' },
        '/testingxyzbdc',
      ),
    ).toBe('app');
  });

  it('is identical when the base path is the root, however it is spelled', () => {
    for (const base of [undefined, '/', '']) {
      expect(bootMode({ pathname: '/replay/s_abc123', search: '?export=1' }, base)).toBe(
        'headless-render',
      );
      expect(bootMode({ pathname: '/sessions/s_abc123', search: '?export=1' }, base)).toBe('app');
    }
  });
});
