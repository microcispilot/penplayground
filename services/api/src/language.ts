import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel, Usage } from '@pen/llm';
import { normalizeTopic } from '@pen/onten';
import { getLIDModel } from 'fasttext.wasm.js';
import { z } from 'zod';
import { logger } from './logger.js';

/**
 * Language identification: fastText lid.176 (Facebook's 176-language model,
 * ~900 KB, offline, ~0.05 ms per call). Measured on our own short topic and
 * question strings it was 23/23 where the n-gram detector was 18/23, so no
 * model call is spent on identification anywhere in the product.
 */
type Lid = Awaited<ReturnType<typeof getLIDModel>>;
let lid: Lid | null = null;

export async function loadLanguageId(): Promise<void> {
  if (lid) return;
  const model = await getLIDModel();
  await model.load();
  lid = model;
}

/** ISO 639-1 → the locale we use for voices and recognition. */
const LOCALES: Record<string, string> = {
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-BR',
  nl: 'nl-NL',
  pl: 'pl-PL',
  ru: 'ru-RU',
  uk: 'uk-UA',
  tr: 'tr-TR',
  ar: 'ar-SA',
  fa: 'fa-IR',
  hi: 'hi-IN',
  bn: 'bn-BD',
  ur: 'ur-PK',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  vi: 'vi-VN',
  th: 'th-TH',
  id: 'id-ID',
  ms: 'ms-MY',
  sv: 'sv-SE',
  da: 'da-DK',
  no: 'nb-NO',
  fi: 'fi-FI',
  el: 'el-GR',
  cs: 'cs-CZ',
  hu: 'hu-HU',
  ro: 'ro-RO',
  he: 'he-IL',
  ca: 'ca-ES',
  tl: 'tl-PH',
  ka: 'ka-GE',
  am: 'am-ET',
  hr: 'hr-HR',
  sk: 'sk-SK',
  bg: 'bg-BG',
  ta: 'ta-IN',
  te: 'te-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  pa: 'pa-IN',
  ml: 'ml-IN',
  kn: 'kn-IN',
  ne: 'ne-NP',
  sq: 'sq-AL',
  az: 'az-AZ',
  kk: 'kk-KZ',
  et: 'et-EE',
  lt: 'lt-LT',
  lv: 'lv-LV',
  sl: 'sl-SI',
  sr: 'sr-RS',
  sw: 'sw-KE',
  af: 'af-ZA',
  is: 'is-IS',
  ga: 'ga-IE',
  mn: 'mn-MN',
};

export interface Detected {
  language: string;
  locale: string;
  /** 0–1 from the classifier. */
  confidence: number;
}

/** Below this the text is too short/ambiguous to act on ("why?", "TCP handshake"): keep the current language. */
const CONFIDENT = 0.5;

/** ~0.05 ms once loaded; English when unloaded or uncertain. */
export async function detectLanguage(text: string, fallback = 'en'): Promise<Detected> {
  const trimmed = text.trim();
  if (!lid || trimmed.length < 2) return locale(fallback, 0);
  const r = await lid.identify(trimmed);
  const code = (r.alpha2 ?? '').toLowerCase();
  const confidence = Number(r.possibility ?? 0);
  if (!code || !(code in LOCALES) || confidence < CONFIDENT) return locale(fallback, confidence);
  return locale(code, confidence);
}

function locale(code: string, confidence: number): Detected {
  const lang = code.split('-')[0] ?? 'en';
  return { language: lang, locale: LOCALES[lang] ?? `${lang}-${lang.toUpperCase()}`, confidence };
}

/**
 * Language of a learner utterance mid-session: only a confident read moves
 * voice and recognition; the model still answers in the question's language.
 */
export async function detectSpokenLanguage(text: string): Promise<string | null> {
  const d = await detectLanguage(text, '');
  return d.confidence >= 0.8 && d.language ? d.locale : null;
}

// ── topic intake ──────────────────────────────────────────────────────────────

const Translation = z.object({
  /** The topic in English, ≤ 8 words, the way an English textbook would name it. */
  canonicalTitle: z.string(),
  /** "en" unless the subject itself belongs to a language (poetry, grammar, songs, a country's law): that ISO 639-1 code. */
  sourceLanguage: z.string(),
});

export interface TopicIntakeResult {
  language: string;
  locale: string;
  /** Title in the learner's language (shown in the UI). */
  title: string;
  /** English title: the key knowledge is stored under. */
  canonicalTitle: string;
  /** Language the knowledge is gathered in ("en" unless the subject is language-bound). */
  sourceLanguage: string;
  /** Where the answer came from (for telemetry). */
  via: 'english' | 'cache' | 'model' | 'fallback';
  /** The translation call's usage when the model was asked; the session prices it. */
  usage: Usage | null;
}

/**
 * English requests never touch a model: identification is local and the
 * cleaned text is the canonical title. Non-English requests need one
 * translation to the English canonical title (and the language-bound check);
 * that result is cached on disk by normalised text, so each distinct topic
 * pays once ever, not once per session.
 */
export class TopicIntake {
  private cache = new Map<string, { canonicalTitle: string; sourceLanguage: string }>();
  private readonly file: string;

  constructor(
    private readonly model: LanguageModel,
    dataDir: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'intake-cache.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<
        string,
        { canonicalTitle: string; sourceLanguage: string }
      >;
      this.cache = new Map(Object.entries(raw));
    } catch {
      this.cache = new Map();
    }
  }

  async intake(text: string): Promise<TopicIntakeResult> {
    const detected = await detectLanguage(text);
    const title = cleanTitle(text, detected.language);
    if (detected.language === 'en') {
      return {
        ...detected,
        title,
        canonicalTitle: title,
        sourceLanguage: 'en',
        via: 'english',
        usage: null,
      };
    }
    const key = `${detected.language}:${normalizeTopic(text)}`;
    const hit = this.cache.get(key);
    if (hit) return { ...detected, title, ...hit, via: 'cache', usage: null };
    try {
      const { value, usage } = await this.model.complete({
        messages: [
          {
            role: 'system',
            content:
              'Translate a learning request into an English topic title (≤ 8 words, as an English textbook would name it). Also decide sourceLanguage: "en" unless the subject itself belongs to a language — poetry, literature, grammar, songs, or one country\'s law in its own language — in which case that ISO 639-1 code.',
          },
          { role: 'user', content: text },
        ],
        schema: Translation,
        schemaName: 'topic_translation',
        cacheKey: 'pen:intake',
        maxOutputTokens: 40,
        purpose: 'intake',
      });
      const source = /^[a-z]{2}$/.test(value.sourceLanguage.trim().toLowerCase())
        ? value.sourceLanguage.trim().toLowerCase()
        : 'en';
      const entry = {
        canonicalTitle: value.canonicalTitle.trim().slice(0, 80) || title,
        sourceLanguage: source,
      };
      this.cache.set(key, entry);
      this.persist();
      return { ...detected, title, ...entry, via: 'model', usage };
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'intake translation failed; using the learner text as the key',
      );
      return {
        ...detected,
        title,
        canonicalTitle: title,
        sourceLanguage: detected.language,
        via: 'fallback',
        usage: null,
      };
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.cache)));
    } catch (error) {
      logger.warn({ err: String(error) }, 'intake cache not persisted');
    }
  }
}

/** Strip "I want to learn" phrasing (English) and title-case; other languages keep the learner's words. */
export function cleanTitle(text: string, language: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (language !== 'en') return t.slice(0, 80);
  const cleaned = normalizeTopic(t);
  if (!cleaned) return t.slice(0, 80);
  return cleaned
    .split(' ')
    .map((w, i) =>
      i > 0 &&
      [
        'a',
        'an',
        'the',
        'of',
        'in',
        'on',
        'for',
        'and',
        'or',
        'to',
        'vs',
        'with',
        'at',
        'by',
      ].includes(w)
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ')
    .slice(0, 80);
}
