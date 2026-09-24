/**
 * Builds the Cartesia voice catalogue from Cartesia's own library (ADR-0048):
 *
 *   CARTESIA_API_KEY=… pnpm --filter @pen/api voices:cartesia
 *
 * Every voice in `GET /voices` is Cartesia's — public, and none of them ours
 * — and the API carries no usage or rating. What it does carry is an order
 * that is not by date and not by name: the library's own, with the voices
 * Cartesia puts first (Skylar, Daniel, Gemma…) at the top. That order is
 * the only quality signal there is, so it is the one used: per language and
 * gender, the first `FLAGSHIP_PER_GENDER` voices are `flagship` and weigh
 * double in assignment; the rest are `professional`. Voices whose
 * description says they are for characters, games, children or the like are
 * left out — an expert is a person explaining, not a mascot.
 *
 * Writes `data/experts/voices.cartesia.json` in the same shape as Fish's
 * catalogue, so `ExpertVoices` reads both.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DATA_DIR } from '../src/services.js';

const key = process.env.CARTESIA_API_KEY;
if (!key) throw new Error('CARTESIA_API_KEY is required');

const FLAGSHIP_PER_GENDER = 8;
/**
 * How deep into the library's order a language's pool goes, per gender. The
 * order is the quality signal; 24 a gender is the top of it, and enough that
 * a hundred personas share each voice with one or two others. The rest of
 * the library is real, but it is not what "the best voices" means.
 */
const POOL_PER_GENDER = 24;
/** Only languages with at least this many usable voices get a pool; the rest fall to English at assignment. */
const MIN_VOICES_PER_LANGUAGE = 2;
const NOT_A_TEACHER =
  /\b(character|cartoon|game|gaming|villain|monster|robot|alien|child|kid|toddler|baby|elderly whisper|ASMR|seductive|sexy|flirt)\b/i;

const Voice = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  tagline: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  gender: z.enum(['masculine', 'feminine', 'gender_neutral']).nullable().optional(),
  status: z.string(),
  access: z.string(),
  accents: z.array(z.object({ locale: z.string(), is_native: z.boolean().optional() })).optional(),
});

async function page(after: string | null) {
  const url = new URL('https://api.cartesia.ai/voices');
  url.searchParams.set('limit', '100');
  if (after) url.searchParams.set('starting_after', after);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14' },
  });
  if (!res.ok) throw new Error(`cartesia ${res.status}: ${await res.text()}`);
  return (await res.json()) as { data: unknown[]; has_more: boolean; next_page?: string | null };
}

const all: z.infer<typeof Voice>[] = [];
let after: string | null = null;
for (;;) {
  const p = await page(after);
  for (const raw of p.data) {
    const parsed = Voice.safeParse(raw);
    if (parsed.success) all.push(parsed.data);
  }
  if (!p.has_more) break;
  after = p.next_page ?? all[all.length - 1]?.id ?? null;
  if (!after) break;
}

const usable = all.filter(
  (v) =>
    v.status === 'active' &&
    v.access === 'public' &&
    (v.gender === 'masculine' || v.gender === 'feminine') &&
    !!v.language &&
    !NOT_A_TEACHER.test(`${v.name} ${v.tagline ?? ''} ${v.description ?? ''}`),
);

const byLanguage = new Map<string, z.infer<typeof Voice>[]>();
for (const v of usable) {
  const lang = (v.language as string).toLowerCase();
  const list = byLanguage.get(lang) ?? [];
  list.push(v);
  byLanguage.set(lang, list);
}

const tagsOf = (v: z.infer<typeof Voice>): string[] =>
  Array.from(
    new Set(
      `${v.tagline ?? ''} ${v.description ?? ''}`
        .toLowerCase()
        .replace(/[^a-z\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3),
    ),
  ).slice(0, 12);

const out: Array<{
  id: string;
  name: string;
  gender: 'woman' | 'man';
  language: string;
  locale: string | null;
  tier: 'flagship' | 'professional';
  tags: string[];
}> = [];
for (const [lang, list] of byLanguage) {
  if (list.length < MIN_VOICES_PER_LANGUAGE) continue;
  const rank = { masculine: 0, feminine: 0 };
  for (const v of list) {
    const g = v.gender as 'masculine' | 'feminine';
    if (rank[g] >= POOL_PER_GENDER) continue;
    const native = v.accents?.find((a) => a.is_native)?.locale ?? null;
    out.push({
      id: v.id,
      name: v.name,
      gender: g === 'feminine' ? 'woman' : 'man',
      language: lang,
      locale: native ? native.toLowerCase() : null,
      tier: rank[g] < FLAGSHIP_PER_GENDER ? 'flagship' : 'professional',
      tags: tagsOf(v),
    });
    rank[g] += 1;
  }
}

const file = join(DATA_DIR, 'experts', 'voices.cartesia.json');
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
const langs = new Map<string, number>();
for (const v of out) langs.set(v.language, (langs.get(v.language) ?? 0) + 1);
console.log(
  `${out.length} of ${all.length} Cartesia voices kept across ${langs.size} languages → ${file}`,
);
console.log(
  [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l}:${n}`)
    .join(' '),
);
console.log(
  'English flagship:',
  out
    .filter((v) => v.language === 'en' && v.tier === 'flagship')
    .map((v) => `${v.name} (${v.gender})`)
    .join(', '),
);
