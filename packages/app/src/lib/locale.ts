import { useEffect } from 'react';

/**
 * A session is taught in the learner's language, so the page has to behave
 * like it: `<html lang>` follows the session (screen readers pick the right
 * voice, browsers the right hyphenation), text written in Persian, Arabic or
 * Hebrew reads right to left, and every date and duration is formatted by
 * `Intl` in the reader's own locale rather than in English.
 *
 * Direction is applied to the text that carries the session's words —
 * captions, pinned notes, the recap, the transcript — not to the whole
 * document: the chrome is the product's own, and flipping it would move
 * every control out from under the learner mid-lesson.
 */

/**
 * Scripts written right to left. `Intl.Locale.getTextInfo()` knows this for
 * every language and is used when the runtime has it (Chrome 130+, Node 22+);
 * this list is the fallback, and the test of the two agreeing.
 */
const RTL_LANGUAGES = new Set([
  'ar', // Arabic
  'arc', // Aramaic
  'ckb', // Central Kurdish
  'dv', // Divehi
  'fa', // Persian
  'he', // Hebrew
  'ks', // Kashmiri
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'ur', // Urdu
  'yi', // Yiddish
]);

export type Direction = 'ltr' | 'rtl';

/** The language subtag of a BCP-47 tag: `fa-IR` → `fa`. */
export function languageOf(tag: string): string {
  return (tag.split('-')[0] ?? tag).toLowerCase();
}

export function isRtl(tag: string | null | undefined): boolean {
  if (!tag) return false;
  try {
    const info = new Intl.Locale(tag) as Intl.Locale & {
      getTextInfo?: () => { direction: string };
      textInfo?: { direction: string };
    };
    const direction = info.getTextInfo?.().direction ?? info.textInfo?.direction;
    if (direction) return direction === 'rtl';
  } catch {
    // A malformed tag is not a reason to render nothing: fall back to the list.
  }
  return RTL_LANGUAGES.has(languageOf(tag));
}

export function dirOf(tag: string | null | undefined): Direction {
  return isRtl(tag) ? 'rtl' : 'ltr';
}

/**
 * `<html lang>` for the page. The document keeps its own direction (the
 * chrome is ours); the language is what assistive technology and the browser
 * read.
 */
export function applyDocumentLanguage(tag: string | null): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = tag && tag.trim() ? tag : 'en';
}

/** Follow a session's language while this screen is mounted; back to English after. */
export function useDocumentLanguage(tag: string | null | undefined): void {
  useEffect(() => {
    if (!tag) return;
    applyDocumentLanguage(tag);
    return () => applyDocumentLanguage(null);
  }, [tag]);
}

/** The reader's own locale — their browser's, not the session's. */
export function readerLocale(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.language || undefined;
}

function formatter<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>(
  build: () => T,
  fallback: () => T | null,
): T | null {
  try {
    return build();
  } catch {
    return fallback();
  }
}

/**
 * "Today", "Yesterday", "3 days ago", then a date — in the reader's language,
 * through `Intl`. The words come from the platform, so a Persian browser
 * reads «امروز» without us shipping a single translation.
 */
export function formatRelativeDay(ts: number, locale = readerLocale(), now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days >= 0 && days < 7) {
    const rtf = formatter(
      () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
      () => new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }),
    );
    if (rtf) return capitalise(rtf.format(-days, 'day'), locale);
  }
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  const dtf = formatter(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' }),
      }),
    () => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }),
  );
  return dtf ? dtf.format(ts) : new Date(ts).toISOString().slice(0, 10);
}

/**
 * "now", "42s ago", "5m ago" — the quiet marker under a line in the room's
 * chat, in the reader's own language and digits ("۴۲ ثانیه پیش").
 */
export function formatElapsed(at: number, now = Date.now(), locale = readerLocale()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const rtf = formatter(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }),
    () => new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' }),
  );
  if (!rtf) return `${seconds}s`;
  if (seconds < 5) return rtf.format(-0, 'second');
  if (seconds < 60) return rtf.format(-seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  return rtf.format(-Math.round(minutes / 60), 'hour');
}

/** "14 min" in the reader's language and numbering system. */
export function formatDurationMinutes(ms: number, locale = readerLocale()): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const nf = formatter(
    () => new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' }),
    () => null,
  );
  return nf ? nf.format(minutes) : `${minutes} min`;
}

/** A full date for a saved session ("17 September 2026"), in the reader's locale. */
export function formatDate(ts: number, locale = readerLocale()): string {
  const dtf = formatter(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'long' }),
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }),
  );
  return dtf ? dtf.format(ts) : new Date(ts).toISOString().slice(0, 10);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `Intl` gives "today" lowercase in English; a line that starts a sentence wants it capitalised. */
function capitalise(text: string, locale = readerLocale()): string {
  const first = text.charAt(0);
  const upper = first.toLocaleUpperCase(locale);
  return upper === first ? text : upper + text.slice(1);
}
