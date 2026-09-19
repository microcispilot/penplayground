import { describe, expect, it } from 'vitest';
import { adminToken, MIN_ADMIN_TOKEN_LENGTH, machineIsAdmin, secretMatches } from '../src/admin.js';
import {
  countryForTimezone,
  knownTimezoneCount,
  resolveGeo,
  safeTimezone,
  utcOffsetMinutes,
} from '../src/stats/geo.js';
import { parseClient } from '../src/stats/user-agent.js';

/** Header lookups are case-insensitive in Hono; these fakes match that. */
const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

describe('geography — what this deployment can honestly say', () => {
  it('places a timezone in a country from ICU, with no dependency and no IP', () => {
    // A representative spread, including a country with one zone and one with many.
    expect(countryForTimezone('Europe/Berlin')).toBe('DE');
    expect(countryForTimezone('America/Los_Angeles')).toBe('US');
    expect(countryForTimezone('Asia/Tehran')).toBe('IR');
    expect(countryForTimezone('Australia/Sydney')).toBe('AU');
    expect(countryForTimezone('Africa/Lagos')).toBe('NG');
    expect(countryForTimezone('America/Sao_Paulo')).toBe('BR');
  });

  it('follows a zone renamed since the browser learned it', () => {
    // `Asia/Calcutta` and `Europe/Kiev` are the old spellings browsers still send.
    expect(countryForTimezone('Asia/Calcutta')).toBe('IN');
    expect(countryForTimezone('Europe/Kiev')).toBe('UA');
  });

  it('places no country on a zone that belongs to none', () => {
    expect(countryForTimezone('UTC')).toBeNull();
    expect(countryForTimezone('Etc/GMT+3')).toBeNull();
    expect(countryForTimezone(null)).toBeNull();
    expect(countryForTimezone('not a zone')).toBeNull();
  });

  it('covers the great majority of the zones this platform knows', () => {
    const known = knownTimezoneCount();
    const all = Intl.supportedValuesOf('timeZone').length;
    expect(known).toBeGreaterThan(300);
    // The remainder are `Etc/*` and `UTC`, which belong to no country by design.
    expect(known / all).toBeGreaterThan(0.85);
  });

  it('says where the country came from, and never invents a region or a city', () => {
    const fromZone = resolveGeo({
      header: headers({}),
      timezone: 'Europe/Berlin',
      trustEdgeHeaders: false,
    });
    expect(fromZone).toEqual({ country: 'DE', region: null, city: null, source: 'timezone' });
  });

  it('ignores an edge header nobody said to trust — otherwise a visitor picks their own country', () => {
    const forged = headers({ 'cf-ipcountry': 'JP', 'x-geo-city': 'Kyoto' });
    expect(
      resolveGeo({ header: forged, timezone: 'Europe/Berlin', trustEdgeHeaders: false }),
    ).toEqual({ country: 'DE', region: null, city: null, source: 'timezone' });
    expect(resolveGeo({ header: forged, timezone: null, trustEdgeHeaders: false }).source).toBe(
      'none',
    );
  });

  it('reads the edge when the deployment says it is trustworthy, region and city included', () => {
    const edge = headers({
      'x-geo-country': 'jp',
      'x-geo-region': 'Kansai',
      'x-geo-city': 'Kyoto',
    });
    expect(resolveGeo({ header: edge, timezone: 'Europe/Berlin', trustEdgeHeaders: true })).toEqual(
      {
        country: 'JP',
        region: 'Kansai',
        city: 'Kyoto',
        source: 'edge',
      },
    );
  });

  it('treats Cloudflare’s unknown and Tor codes as no country at all', () => {
    for (const code of ['XX', 'T1', 'not-a-code', '']) {
      expect(
        resolveGeo({
          header: headers({ 'cf-ipcountry': code }),
          timezone: null,
          trustEdgeHeaders: true,
        }).country,
      ).toBeNull();
    }
  });

  it('strips control characters out of an edge place name', () => {
    const nasty = headers({
      'x-geo-country': 'FR',
      'x-geo-city': `Pa${String.fromCharCode(0)}ris<script>`,
    });
    expect(resolveGeo({ header: nasty, timezone: null, trustEdgeHeaders: true }).city).toBe(
      'Parisscript',
    );
  });

  it('reads the visitor’s own offset so "hour of day" means their hour', () => {
    // 15 January 2024, 12:00 UTC — northern winter, so no summer time anywhere north.
    const winter = Date.UTC(2024, 0, 15, 12, 0, 0);
    expect(utcOffsetMinutes('Europe/Berlin', winter)).toBe(60);
    expect(utcOffsetMinutes('America/New_York', winter)).toBe(-300);
    expect(utcOffsetMinutes('Asia/Kolkata', winter)).toBe(330);
    expect(utcOffsetMinutes('UTC', winter)).toBe(0);
    // And it moves with summer time rather than being a fixed number per zone.
    const summer = Date.UTC(2024, 6, 15, 12, 0, 0);
    expect(utcOffsetMinutes('Europe/Berlin', summer)).toBe(120);
    expect(utcOffsetMinutes('nonsense/zone', summer)).toBeNull();
  });

  it('refuses a timezone that is not shaped like one', () => {
    expect(safeTimezone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(safeTimezone('America/Argentina/Ushuaia')).toBe('America/Argentina/Ushuaia');
    expect(safeTimezone('../../etc/passwd')).toBeNull();
    expect(safeTimezone('x'.repeat(100))).toBeNull();
    expect(safeTimezone(null)).toBeNull();
  });
});

describe('device — from the User-Agent, which is then dropped', () => {
  const cases: Array<[string, string, ReturnType<typeof parseClient>]> = [
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      { deviceType: 'desktop', os: 'Windows', browser: 'Chrome', browserMajor: 131 },
    ],
    [
      'Safari on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      { deviceType: 'desktop', os: 'macOS', browser: 'Safari', browserMajor: 17 },
    ],
    [
      'Safari on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      { deviceType: 'mobile', os: 'iOS', browser: 'Safari', browserMajor: 17 },
    ],
    [
      'Safari on iPad',
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      { deviceType: 'tablet', os: 'iPadOS', browser: 'Safari', browserMajor: 17 },
    ],
    [
      'Chrome on Android phone',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      { deviceType: 'mobile', os: 'Android', browser: 'Chrome', browserMajor: 131 },
    ],
    [
      'Chrome on an Android tablet (no Mobile token)',
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      { deviceType: 'tablet', os: 'Android', browser: 'Chrome', browserMajor: 131 },
    ],
    [
      'Edge, which also claims to be Chrome and Safari',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      { deviceType: 'desktop', os: 'Windows', browser: 'Edge', browserMajor: 131 },
    ],
    [
      'Firefox on Linux',
      'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
      { deviceType: 'desktop', os: 'Linux', browser: 'Firefox', browserMajor: 133 },
    ],
    [
      'Samsung Internet, which also claims to be Chrome',
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      { deviceType: 'mobile', os: 'Android', browser: 'Samsung Internet', browserMajor: 23 },
    ],
    [
      'ChromeOS',
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      { deviceType: 'desktop', os: 'ChromeOS', browser: 'Chrome', browserMajor: 131 },
    ],
  ];
  for (const [name, ua, expected] of cases) {
    it(`reads ${name}`, () => expect(parseClient(ua)).toEqual(expected));
  }

  it('counts a crawler as a bot rather than a person', () => {
    expect(
      parseClient('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
    ).toMatchObject({ deviceType: 'bot', browser: null });
    expect(parseClient('curl/8.4.0').deviceType).toBe('bot');
    // The export renderer opens the replay page in headless Chromium; it is
    // not a visitor and must not be counted as one.
    expect(
      parseClient('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0.0.0 Safari/537.36')
        .deviceType,
    ).toBe('bot');
  });

  it('prefers the client hints Chromium actually means', () => {
    const lying =
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36';
    expect(parseClient(lying, { platform: '"Android"', mobile: '?1' })).toMatchObject({
      deviceType: 'mobile',
      os: 'Android',
    });
    // `Sec-CH-UA-Mobile: ?0` on a desktop overrides a phone-shaped string.
    expect(parseClient(lying, { platform: '"Windows"', mobile: '?0' }).os).toBe('Windows');
  });

  it('answers unknown rather than guessing when it has nothing', () => {
    expect(parseClient(undefined)).toEqual({
      deviceType: 'unknown',
      os: null,
      browser: null,
      browserMajor: null,
    });
    expect(parseClient('')).toMatchObject({ deviceType: 'unknown' });
  });
});

describe('the machine way into the reports', () => {
  const token = 'k'.repeat(40);
  const headers = (patch: Partial<Parameters<typeof machineIsAdmin>[1]> = {}) => ({
    authorization: undefined,
    adminToken: undefined,
    ...patch,
  });

  it('accepts the configured token in either header', () => {
    expect(machineIsAdmin(token, headers({ adminToken: token }))).toBe(true);
    expect(machineIsAdmin(token, headers({ authorization: `Bearer ${token}` }))).toBe(true);
  });

  it('accepts nothing close to it', () => {
    expect(machineIsAdmin(token, headers({ adminToken: `${token}x` }))).toBe(false);
    expect(machineIsAdmin(token, headers({ adminToken: 'k'.repeat(39) }))).toBe(false);
    expect(machineIsAdmin(token, headers({ authorization: token }))).toBe(false);
    expect(machineIsAdmin(token, headers())).toBe(false);
  });

  it('is unset — and so refuses everyone — below 32 characters', () => {
    expect(adminToken({ PEN_ADMIN_TOKEN: 'short' })).toBeNull();
    expect(adminToken({ PEN_ADMIN_TOKEN: 'a'.repeat(MIN_ADMIN_TOKEN_LENGTH - 1) })).toBeNull();
    expect(adminToken({ PEN_ADMIN_TOKEN: 'a'.repeat(MIN_ADMIN_TOKEN_LENGTH) })).not.toBeNull();
    expect(adminToken({})).toBeNull();
    expect(machineIsAdmin(null, headers({ adminToken: 'short' }))).toBe(false);
  });

  it('never matches an empty or absent secret', () => {
    expect(secretMatches(null, 'anything')).toBe(false);
    expect(secretMatches('k'.repeat(40), undefined)).toBe(false);
    expect(secretMatches('', '')).toBe(false);
  });
});
