import { francAll } from 'franc';

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
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  let code = 'eng';
  if (trimmed.length >= 12) {
    // Only the languages we can actually teach in, and a clear margin over the runner-up:
    // short topic strings are easy to misread ("Swift fundamentals" scores as Catalan unconstrained).
    const ranked = francAll(trimmed, { minLength: 12, only: Object.keys(LOCALES) });
    const top = ranked[0];
    const second = ranked[1];
    const nonLatin = /[^\p{Script=Latin}\s\d\p{P}\p{S}]/u.test(trimmed);
    if (top && top[0] !== 'und') {
      const margin = second ? top[1] - second[1] : 1;
      const confident = nonLatin || margin >= 0.12 || words >= 8;
      if (confident || top[0] === 'eng') code = top[0];
    }
  }
  const locale = LOCALES[code] ?? 'en-US';
  return { language: locale.split('-')[0] ?? 'en', locale };
}

// ── model-assisted intake ─────────────────────────────────────────────────────
import type { LanguageModel } from '@pen/llm';
import { z } from 'zod';

export const TopicIntake = z.object({
  /** BCP-47 tag of the language the learner wrote in (en-US, es-ES, ja-JP …). */
  language: z.string(),
  /** Clean topic title in that language, ≤ 8 words, no "I want to learn". */
  title: z.string(),
});
export type TopicIntake = z.infer<typeof TopicIntake>;

/**
 * Short topic strings defeat n-gram detectors ("Swift fundamentals" reads as
 * Catalan), so the cheap model reads the intent instead: language + a clean
 * title. Falls back to the statistical detector when the model is unavailable.
 */
export async function intakeTopic(
  model: LanguageModel,
  text: string,
): Promise<{ language: string; locale: string; title: string }> {
  try {
    const { value } = await model.complete({
      messages: [
        {
          role: 'system',
          content:
            'You classify a learning request. Return the BCP-47 language tag the learner wrote in (default en-US when unsure; code identifiers do not change the language) and a clean topic title in that same language, at most 8 words, without phrases like "I want to learn".',
        },
        { role: 'user', content: text },
      ],
      schema: TopicIntake,
      schemaName: 'topic_intake',
      cacheKey: 'pen:intake',
      maxOutputTokens: 60,
      purpose: 'intake',
    });
    const locale = normaliseLocale(value.language);
    return {
      language: locale.split('-')[0] ?? 'en',
      locale,
      title: value.title.trim().slice(0, 80) || text,
    };
  } catch {
    const detected = detectLanguage(text);
    return { ...detected, title: text };
  }
}

function normaliseLocale(tag: string): string {
  const m = /^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{2,4}))?/.exec(tag.trim());
  if (!m) return 'en-US';
  const lang = (m[1] ?? 'en').toLowerCase();
  const region = m[2]?.toUpperCase();
  if (region) return `${lang}-${region}`;
  const known = Object.values(LOCALES).find((l) => l.startsWith(`${lang}-`));
  return known ?? `${lang}-${lang.toUpperCase()}`;
}
