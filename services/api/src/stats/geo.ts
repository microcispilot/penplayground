import type { GeoSource } from '@pen/contracts';

/**
 * Where a visitor is, as honestly as this deployment can say (ADR-0027).
 *
 * There is no Cloudflare in front of us, the nginx on the deploy host has no
 * geoip module loaded, and there is no MaxMind database anywhere in the repo
 * or the image (`deploy/nginx/pen-playground.conf.example`,
 * `apps/web/Dockerfile` → `nginx:1.30-alpine`). Region and city cannot be had
 * today without adding one of those, and adding one was not worth doing
 * quietly. So there are exactly two sources, and every row says which it used:
 *
 * 1. **A trusted edge header.** If a proxy ever sets one — Cloudflare's
 *    `CF-IPCountry`, or `X-Geo-Country` / `X-Geo-Region` / `X-Geo-City` from
 *    an nginx with `ngx_http_geoip2_module` — turning on
 *    `PEN_TRUST_GEO_HEADERS` reads it, and region and city light up with no
 *    further change here. It is off by default because a header nobody sets
 *    is a header anybody can forge.
 *
 * 2. **The browser's own IANA timezone**, mapped to a country through ICU's
 *    CLDR data, which Node already carries. Coarse — one country, no region,
 *    no city — and wrong for a traveller or a VPN. It costs nothing, needs no
 *    service, and, unlike an IP lookup, requires storing no IP address at all.
 *
 * **No IP address is stored by any of this.** `clientKey` still reads
 * `X-Real-IP` for rate limiting, in memory, as it always has; nothing in the
 * statistics writes it down.
 */

/*
 * `Intl.Locale.prototype.timeZones` is implemented in V8 — and so in the Node
 * this runs on — ahead of TypeScript's lib declarations, which is why the one
 * call to it below widens the type at the call site and nowhere else.
 */

export interface GeoResolution {
  country: string | null;
  region: string | null;
  city: string | null;
  source: GeoSource;
}

export const NO_GEO: GeoResolution = {
  country: null,
  region: null,
  city: null,
  source: 'none',
};

/** Headers a proxy may set. Read only when the deployment says the edge is trustworthy. */
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-geo-country'] as const;
const REGION_HEADERS = ['x-geo-region'] as const;
const CITY_HEADERS = ['x-geo-city'] as const;

/** ISO-3166-1 alpha-2, or null. `XX`/`T1` are Cloudflare's "unknown" and "Tor". */
function country(value: string | undefined): string | null {
  if (!value) return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

/** A place name from the edge: short, printable, and never trusted into SQL as anything but a value. */
function place(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value
    .trim()
    // Control characters and angle brackets: an edge header is still input.
    .replace(/[\p{Cc}<>]/gu, '')
    .slice(0, 80);
  return clean.length > 0 ? clean : null;
}

// ── IANA zone → country, from ICU ────────────────────────────────────────────
/**
 * Built once from the platform's own CLDR tables: for every region code ICU
 * knows, the zones it contains. No data file to keep current — an ICU upgrade
 * updates it — and no dependency.
 */
let zoneToCountry: Map<string, string> | null = null;

/**
 * ISO 3166-3: codes that named a country that no longer exists. ICU still
 * answers for them, and skipping them is not optional — `Europe/Berlin` is
 * listed under `DD` (the German Democratic Republic) as well as `DE`, and an
 * alphabetical walk would file every visitor in Germany under East Germany.
 * With these excluded every one of the 418 zones this platform knows maps to
 * exactly one current country and none maps to two (`stats-client.test.ts`).
 * The list is history and does not change.
 */
const RETIRED_REGIONS = new Set([
  'AN', // Netherlands Antilles → CW and others
  'BU', // Burma → MM
  'CS', // Serbia and Montenegro → RS
  'CT', // Canton and Enderbury → KI
  'DD', // German Democratic Republic → DE
  'DY', // Dahomey → BJ
  'FQ', // French Southern and Antarctic Territories → AQ
  'FX', // Metropolitan France → FR
  'HV', // Upper Volta → BF
  'JT', // Johnston Island → UM
  'MI', // Midway Islands → UM
  'NH', // New Hebrides → VU
  'NQ', // Dronning Maud Land → AQ
  'NT', // Neutral Zone → SA
  'PC', // Pacific Islands Trust Territory → FM and others
  'PU', // US Miscellaneous Pacific Islands → UM
  'PZ', // Panama Canal Zone → PA
  'RH', // Southern Rhodesia → ZW
  'SU', // Soviet Union → RU and others
  'TP', // East Timor → TL
  'UK', // an alias for GB, not an ISO code
  'VD', // North Vietnam → VN
  'WK', // Wake Island → UM
  'YD', // Democratic Yemen → YE
  'YU', // Yugoslavia → RS
  'ZR', // Zaire → CD
]);

function buildZoneMap(): Map<string, string> {
  const map = new Map<string, string>();
  // `Intl.Locale.prototype.timeZones` is region → zones; the reverse is what
  // is wanted, and with the retired codes out it is one country per zone.
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const region = String.fromCharCode(a, b);
      if (RETIRED_REGIONS.has(region)) continue;
      let zones: string[] | undefined;
      try {
        zones = (new Intl.Locale(`und-${region}`) as Intl.Locale & { timeZones?: string[] })
          .timeZones;
      } catch {
        zones = undefined;
      }
      if (!zones) continue;
      for (const zone of zones) if (!map.has(zone)) map.set(zone, region);
    }
  }
  return map;
}

/**
 * The country an IANA zone belongs to, or null for one ICU does not place
 * (`UTC`, `Etc/GMT+3`, a zone newer than this Node's ICU).
 */
export function countryForTimezone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  zoneToCountry ??= buildZoneMap();
  const direct = zoneToCountry.get(timezone);
  if (direct) return direct;
  // A zone the browser reports under an old name (`Asia/Calcutta`,
  // `Europe/Kiev`): ICU will canonicalise it for us.
  try {
    const canonical =
      Intl.supportedValuesOf('timeZone').length > 0
        ? new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
        : timezone;
    return canonical === timezone ? null : (zoneToCountry.get(canonical) ?? null);
  } catch {
    return null;
  }
}

/** Zones this ICU can place, for a test and for the readiness note. */
export function knownTimezoneCount(): number {
  zoneToCountry ??= buildZoneMap();
  return zoneToCountry.size;
}

export interface GeoInput {
  header(name: string): string | undefined;
  /** The IANA zone the page reported, when it reported one. */
  timezone?: string | null;
  /** `PEN_TRUST_GEO_HEADERS`: the edge in front of us sets geo headers and nothing else can. */
  trustEdgeHeaders: boolean;
}

/** The edge first, the browser's clock second, nothing third. */
export function resolveGeo(input: GeoInput): GeoResolution {
  if (input.trustEdgeHeaders) {
    const code = COUNTRY_HEADERS.map((h) => country(input.header(h))).find((v) => v !== null);
    if (code) {
      return {
        country: code,
        region: REGION_HEADERS.map((h) => place(input.header(h))).find((v) => v !== null) ?? null,
        city: CITY_HEADERS.map((h) => place(input.header(h))).find((v) => v !== null) ?? null,
        source: 'edge',
      };
    }
  }
  const fromZone = countryForTimezone(input.timezone);
  if (fromZone) return { country: fromZone, region: null, city: null, source: 'timezone' };
  return NO_GEO;
}

/**
 * Minutes east of UTC for a zone at a moment — how "hour of day" is read in
 * the visitor's own clock rather than ours. Null when the zone is unknown.
 */
export function utcOffsetMinutes(timezone: string | null | undefined, at: number): number | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
    const hour = get('hour');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      hour === 24 ? 0 : hour,
      get('minute'),
      get('second'),
    );
    if (!Number.isFinite(asUtc)) return null;
    // Rounded to the minute: a handful of historical zones are off by seconds.
    return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
  } catch {
    return null;
  }
}

/** A short, safe IANA zone or null; anything else the page sends is ignored. */
export function safeTimezone(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+){0,2}$/.test(v) && v.length <= 64 ? v : null;
}
