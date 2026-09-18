/**
 * Which way a piece of board text is written. The board draws glyph by glyph
 * left to right, which is right for Latin and Cyrillic and wrong for Arabic
 * script: those letters join and run the other way, so a run of them is drawn
 * as one shaped text run instead (see `ink-text`).
 *
 * The test is the text itself rather than a language tag, because a lesson in
 * Persian still writes `q·k / √d` the Latin way.
 */

/** Arabic, Hebrew, Syriac, Thaana, N'Ko and their supplements. */
const RTL_CHARS = /[֐-׿؀-ۿ܀-ݏݐ-ݿ߀-߿ހ-޿ࢠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]|[\u{10800}-\u{10FFF}]|[\u{1E800}-\u{1EFFF}]/u;

/** Language tags whose script is right-to-left, for text that carries no strong character. */
const RTL_LANGUAGES = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

/** True when the text contains a right-to-left letter. */
export function hasRtlChars(text: string): boolean {
  return RTL_CHARS.test(text);
}

/**
 * The direction to draw `text` in. A strong right-to-left character decides
 * it; failing that, the language the text was written in (a Persian note whose
 * question is only digits still belongs on the right).
 */
export function isRtlText(text: string, language?: string | null): boolean {
  if (hasRtlChars(text)) return true;
  if (!language) return false;
  return RTL_LANGUAGES.has((language.split('-')[0] ?? language).toLowerCase());
}
