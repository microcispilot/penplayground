import { franc } from 'franc';

/** ISO 639-3 → BCP-47 for the languages Fish s2.1-pro and the recognizers cover well. */
const LOCALES: Record<string, string> = {
  eng: 'en-US',
  spa: 'es-ES',
  fra: 'fr-FR',
  deu: 'de-DE',
  ita: 'it-IT',
  por: 'pt-BR',
  nld: 'nl-NL',
  pol: 'pl-PL',
  rus: 'ru-RU',
  ukr: 'uk-UA',
  tur: 'tr-TR',
  ara: 'ar-SA',
  pes: 'fa-IR',
  hin: 'hi-IN',
  ben: 'bn-BD',
  urd: 'ur-PK',
  jpn: 'ja-JP',
  kor: 'ko-KR',
  cmn: 'zh-CN',
  zho: 'zh-CN',
  yue: 'zh-HK',
  vie: 'vi-VN',
  tha: 'th-TH',
  ind: 'id-ID',
  msa: 'ms-MY',
  swe: 'sv-SE',
  dan: 'da-DK',
  nob: 'nb-NO',
  fin: 'fi-FI',
  ell: 'el-GR',
  ces: 'cs-CZ',
  hun: 'hu-HU',
  ron: 'ro-RO',
  heb: 'he-IL',
  cat: 'ca-ES',
  tgl: 'tl-PH',
  kat: 'ka-GE',
  amh: 'am-ET',
  hrv: 'hr-HR',
  slk: 'sk-SK',
  bul: 'bg-BG',
  tam: 'ta-IN',
  tel: 'te-IN',
  mar: 'mr-IN',
  guj: 'gu-IN',
  pan: 'pa-IN',
  mal: 'ml-IN',
  kan: 'kn-IN',
  nep: 'ne-NP',
};

/**
 * Detects the learner's language from the topic text. Short topics are hard
 * to classify, so anything below franc's confidence floor is treated as
 * English; a session may still be created with an explicit language.
 */
export function detectLanguage(text: string): { language: string; locale: string } {
  const code = text.trim().length >= 12 ? franc(text, { minLength: 12 }) : 'und';
  const locale = LOCALES[code] ?? 'en-US';
  return { language: locale.split('-')[0] ?? 'en', locale };
}
