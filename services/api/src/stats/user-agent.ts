import type { DeviceType } from '@pen/contracts';

/**
 * Which kind of machine a visit came from (ADR-0027).
 *
 * Deliberately small, and deliberately not a dependency. A full UA library
 * carries thousands of regular expressions to tell one embedded webview from
 * another; what a statistics page needs is "phone or laptop, which browser,
 * which operating system", and being wrong about a 0.1 % browser costs
 * nothing. Everything it does not recognise is `unknown`, which is an honest
 * answer and shows up as such in the report.
 *
 * The raw User-Agent string is never stored. It is read once, reduced to
 * these four fields, and dropped — it is a fingerprinting surface, and
 * keeping it would be collecting far more than the question needs.
 *
 * Client hints (`Sec-CH-UA-Platform`, `Sec-CH-UA-Mobile`) win where the
 * browser sends them, because they are what Chromium actually means; the
 * User-Agent string is increasingly a fiction it keeps for compatibility.
 */

export interface ParsedClient {
  deviceType: DeviceType;
  os: string | null;
  browser: string | null;
  browserMajor: number | null;
}

export const UNKNOWN_CLIENT: ParsedClient = {
  deviceType: 'unknown',
  os: null,
  browser: null,
  browserMajor: null,
};

export interface ClientHints {
  /** `Sec-CH-UA-Platform`, a quoted token: `"macOS"`. */
  platform?: string | undefined;
  /** `Sec-CH-UA-Mobile`: `?1` on a phone. */
  mobile?: string | undefined;
}

/** Order matters: every one of these also claims to be the ones after it. */
const BROWSERS: Array<{ name: string; re: RegExp }> = [
  { name: 'Edge', re: /Edg(?:iOS|A|)\/(\d+)/ },
  { name: 'Opera', re: /OPR\/(\d+)/ },
  { name: 'Opera', re: /Opera[ /](\d+)/ },
  { name: 'Samsung Internet', re: /SamsungBrowser\/(\d+)/ },
  { name: 'Chrome', re: /(?:CriOS|Chrome)\/(\d+)/ },
  { name: 'Firefox', re: /(?:FxiOS|Firefox)\/(\d+)/ },
  { name: 'Safari', re: /Version\/(\d+)(?:\.\d+)*\s+(?:Mobile\/\S+\s+)?Safari/ },
];

const OSES: Array<{ name: string; re: RegExp }> = [
  { name: 'iPadOS', re: /iPad/ },
  { name: 'iOS', re: /iPhone|iPod/ },
  { name: 'Android', re: /Android/ },
  { name: 'ChromeOS', re: /CrOS/ },
  { name: 'Windows', re: /Windows NT/ },
  { name: 'macOS', re: /Mac OS X|Macintosh/ },
  { name: 'Linux', re: /Linux|X11/ },
];

/**
 * Anything that says it is a crawler. Counted as `bot` and kept out of the
 * human numbers rather than dropped, because "how much of our traffic is
 * crawlers" is itself a question worth being able to answer.
 */
const BOT =
  /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|headlesschrome|lighthouse|playwright|puppeteer|curl|wget|python-requests|node-fetch|axios|monitor|uptime|pingdom|semrush|ahrefs|preview|validator/i;

/** Platform names Chromium sends in `Sec-CH-UA-Platform`, mapped to ours. */
const HINT_PLATFORM: Record<string, string> = {
  android: 'Android',
  chromeos: 'ChromeOS',
  'chrome os': 'ChromeOS',
  ios: 'iOS',
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
};

export function parseClient(
  userAgent: string | undefined | null,
  hints: ClientHints = {},
): ParsedClient {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
  if (ua.length === 0 && !hints.platform) return UNKNOWN_CLIENT;
  if (BOT.test(ua))
    return { deviceType: 'bot', os: osOf(ua, hints), browser: null, browserMajor: null };

  const browser = browserOf(ua);
  const os = osOf(ua, hints);
  return {
    deviceType: deviceOf(ua, os, hints),
    os,
    browser: browser?.name ?? null,
    browserMajor: browser?.major ?? null,
  };
}

function browserOf(ua: string): { name: string; major: number } | null {
  for (const { name, re } of BROWSERS) {
    const m = re.exec(ua);
    if (m) {
      const major = Number(m[1]);
      return { name, major: Number.isFinite(major) ? major : 0 };
    }
  }
  // A WebView with no browser token of its own still has a Chromium version.
  const webview = /Chrome\/(\d+)/.exec(ua);
  return webview ? { name: 'Chromium', major: Number(webview[1]) } : null;
}

function osOf(ua: string, hints: ClientHints): string | null {
  const hinted = hints.platform?.replace(/^"|"$/g, '').trim().toLowerCase();
  const fromHint = hinted ? HINT_PLATFORM[hinted] : undefined;
  // The hint says "macOS" for an iPad too (it reports as a Mac on purpose);
  // the UA is the only thing that still distinguishes them, so it wins there.
  if (/iPad/.test(ua)) return 'iPadOS';
  if (fromHint) return fromHint;
  for (const { name, re } of OSES) if (re.test(ua)) return name;
  return null;
}

function deviceOf(ua: string, os: string | null, hints: ClientHints): DeviceType {
  if (hints.mobile === '?1') return /iPad|Tablet/.test(ua) ? 'tablet' : 'mobile';
  if (os === 'iPadOS') return 'tablet';
  // Safari on an iPad set to "Request desktop website" reports as a Mac with
  // touch; there is nothing left to tell it apart, and it counts as desktop.
  if (/Tablet|Nexus (?:7|9|10)|SM-T|Kindle|Silk/.test(ua)) return 'tablet';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'mobile' : 'tablet';
  if (/iPhone|iPod|Mobile|Windows Phone/.test(ua)) return 'mobile';
  if (os !== null) return 'desktop';
  return 'unknown';
}
