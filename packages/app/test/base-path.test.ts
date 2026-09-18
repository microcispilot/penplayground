import { describe, expect, it } from 'vitest';
import {
  normalizeBasePath,
  routerBasename,
  stripBasePath,
  withBasePath,
} from '../src/lib/base-path.js';

/**
 * The prefix a deployment can mount the app under. Two things are being
 * proved here and the second matters as much as the first: that a prefix is
 * threaded correctly, and that the root deployment — every value a host
 * actually passes for it (`undefined`, `''`, `/`) — comes out exactly as it
 * did before any of this existed.
 */
describe('normalizeBasePath', () => {
  it('is empty for every shape of "the root"', () => {
    for (const root of [undefined, null, '', '   ', '/', '//']) {
      expect(normalizeBasePath(root)).toBe('');
    }
  });

  it('takes anything a host may pass and returns a concatenable prefix', () => {
    // Vite's own BASE_URL shape, an env var without slashes, and the sloppy ones.
    expect(normalizeBasePath('/testingxyzbdc/')).toBe('/testingxyzbdc');
    expect(normalizeBasePath('testingxyzbdc')).toBe('/testingxyzbdc');
    expect(normalizeBasePath('/testingxyzbdc')).toBe('/testingxyzbdc');
    expect(normalizeBasePath('  /testingxyzbdc//  ')).toBe('/testingxyzbdc');
    expect(normalizeBasePath('/a/b/')).toBe('/a/b');
  });
});

describe('routerBasename', () => {
  it('is "/" at the root, so react-router behaves exactly as it always has', () => {
    expect(routerBasename(undefined)).toBe('/');
    expect(routerBasename('/')).toBe('/');
  });

  it('is the prefix under a prefix', () => {
    expect(routerBasename('/testingxyzbdc/')).toBe('/testingxyzbdc');
  });
});

describe('withBasePath', () => {
  it('leaves root-deployment paths untouched', () => {
    expect(withBasePath('/', '/')).toBe('/');
    expect(withBasePath('/', '/pricing')).toBe('/pricing');
    expect(withBasePath(undefined, '/sessions/s_1')).toBe('/sessions/s_1');
  });

  it('puts the prefix in front of an app path', () => {
    expect(withBasePath('/testingxyzbdc/', '/')).toBe('/testingxyzbdc/');
    expect(withBasePath('/testingxyzbdc', '/pricing')).toBe('/testingxyzbdc/pricing');
    expect(withBasePath('/testingxyzbdc', '/sessions/s_1')).toBe('/testingxyzbdc/sessions/s_1');
    expect(withBasePath('/testingxyzbdc', 'replay/s_1')).toBe('/testingxyzbdc/replay/s_1');
  });

  it('builds the API base the client concatenates onto', () => {
    const origin = 'https://sdjust.penplayground.com';
    expect(`${origin}${normalizeBasePath('/testingxyzbdc/')}/api/me`).toBe(
      'https://sdjust.penplayground.com/testingxyzbdc/api/me',
    );
    expect(`${origin}${normalizeBasePath('/')}/api/me`).toBe(
      'https://sdjust.penplayground.com/api/me',
    );
  });
});

describe('stripBasePath', () => {
  it('is the identity at the root', () => {
    expect(stripBasePath('/', '/replay/s_1')).toBe('/replay/s_1');
    expect(stripBasePath(undefined, '/')).toBe('/');
  });

  it('gives back the route under a prefix', () => {
    expect(stripBasePath('/testingxyzbdc/', '/testingxyzbdc/replay/s_1')).toBe('/replay/s_1');
    expect(stripBasePath('/testingxyzbdc', '/testingxyzbdc')).toBe('/');
    expect(stripBasePath('/testingxyzbdc', '/testingxyzbdc/')).toBe('/');
  });

  it('does not strip a prefix that only looks alike', () => {
    expect(stripBasePath('/testingxyzbdc', '/testingxyzbdcXYZ/replay/s_1')).toBe(
      '/testingxyzbdcXYZ/replay/s_1',
    );
    expect(stripBasePath('/testingxyzbdc', '/other/replay/s_1')).toBe('/other/replay/s_1');
  });
});
