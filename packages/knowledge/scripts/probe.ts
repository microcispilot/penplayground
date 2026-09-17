/**
 * Runs the corpus builder for real against the curated seeds (no web search):
 *   pnpm --filter @pen/knowledge probe -- "swift fundamentals"
 * Uses OpenAILanguageModel when OPENAI_API_KEY_FREE is set (loaded from the
 * repo .env by `node --env-file`); otherwise the heuristic outline/evalset.
 * Prints every progress line, then the unit count of the provisional and the
 * qualified pack. Never prints keys.
 */
import { FakeLanguageModel, type LanguageModel, OpenAILanguageModel } from '@pen/llm';
import { createOnten } from '@pen/onten';
import { CorpusBuilder } from '../src/builder.js';
import { NoSearch } from '../src/search.js';
import type { KnowledgeObserver } from '../src/types.js';

const topic =
  process.argv
    .slice(2)
    .filter((a) => a !== '--')
    .join(' ')
    .trim() || 'swift fundamentals';
const apiKey = process.env.OPENAI_API_KEY_FREE?.trim();
const modelName =
  process.env.PEN_LLM_OUTLINE_MODEL?.trim() || process.env.PEN_LLM_MODEL?.trim() || 'gpt-5-mini';
const baseURL = process.env.PEN_LLM_BASE_URL?.trim();

const model: LanguageModel = apiKey
  ? new OpenAILanguageModel({
      apiKey,
      model: modelName,
      reasoningEffort: 'low',
      ...(baseURL ? { baseURL } : {}),
    })
  : new FakeLanguageModel([], []);

const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const log = (line: string) => process.stdout.write(`${line}\n`);

const observer: KnowledgeObserver = {
  event: (name, data) => {
    if (
      name === 'knowledge.page' ||
      name === 'knowledge.page_skipped' ||
      name === 'knowledge.reference'
    )
      log(
        `  [${stamp()}] ${name.replace('knowledge.', '')} ${String(data.url)}${data.reason ? ` (${String(data.reason)})` : ''}`,
      );
    else log(`  [${stamp()}] ${name} ${JSON.stringify(data)}`);
  },
  error: (area, error, data) =>
    log(
      `  [${stamp()}] ERROR ${area}: ${error instanceof Error ? error.message : String(error)} ${data ? JSON.stringify(data) : ''}`,
    ),
};

async function main(): Promise<void> {
  log(
    `Topic: "${topic}" · model: ${apiKey ? modelName : 'none (heuristic outline; set OPENAI_API_KEY_FREE in .env)'} · search: none (seeds only)`,
  );
  const onten = createOnten();
  const resolution = await onten.registry.resolveTopic({
    text: topic,
    language: 'en',
    locale: 'en-US',
    band: 'beginner',
  });
  log(
    `Resolved: ${resolution.title} (${resolution.canonicalKnowledgeId}, ${resolution.domainBoundary}, ${resolution.match})`,
  );

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const builder = new CorpusBuilder({
    compiler: onten.compiler,
    model,
    policy: onten.policy,
    search: new NoSearch(),
    observer,
  });

  const prepared = await builder.prepare({
    resolution,
    signal: controller.signal,
    onProgress: (p) =>
      log(
        `[${stamp()}] ${p.stage.padEnd(11)} ${String(Math.round(p.fraction * 100)).padStart(3)}%  ${p.status}  (${p.sourcesFetched}/${p.sourcesFound})`,
      ),
  });
  const provisional = await onten.registry.getPack(prepared.packId);
  log(
    `\nInteractive after ${stamp()}: pack ${prepared.packId} · ${provisional?.units.length ?? 0} units from ${provisional?.sources.length ?? 0} sources (provisional)`,
  );

  const reference = await prepared.background;
  const pack = await onten.registry.getPack(prepared.packId);
  const outline = await prepared.outline;
  log(`\nBackground done after ${stamp()}: ${reference ? 'qualified' : 'NOT qualified'}`);
  log(
    `Units: ${pack?.units.length ?? 0} · sources: ${pack?.sources.length ?? 0} · references (cite-only): ${prepared.references.length}`,
  );
  log(
    `Evaluation: ${pack?.evaluation.development.length ?? 0} development + ${pack?.evaluation.negative.length ?? 0} negative`,
  );
  log(`Curriculum: ${outline.curriculum.join(' · ')}`);
  const kinds = new Map<string, number>();
  for (const u of pack?.units ?? []) kinds.set(u.kind, (kinds.get(u.kind) ?? 0) + 1);
  log(`Unit kinds: ${[...kinds].map(([k, n]) => `${k}=${n}`).join(', ')}`);
}

main().catch((error) => {
  process.stderr.write(
    `probe failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
