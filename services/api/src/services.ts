import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanCode } from '@pen/contracts';
import { type Connection, connect, ParticipantRepository, SessionRepository } from '@pen/db';
import {
  type CostMeter,
  FakeLanguageModel,
  type LanguageModel,
  OpenAILanguageModel,
  type Usage,
} from '@pen/llm';
import { createOnten, type Onten } from '@pen/onten';
import { ExpertCatalog, type KnowledgeAcquirer } from '@pen/session-engine';
import {
  FishBridgeSynthesizer,
  FishCloudSynthesizer,
  SilentSynthesizer,
  type SpeechRecognizerFactory,
  type SpeechSynthesizer,
} from '@pen/voice';
import { Analytics } from './analytics.js';
import { Billing } from './billing.js';
import type { Config } from './config.js';
import { demoScripts } from './demo-scripts.js';
import { DownloadTokens, ExportJobs, PlaywrightRenderer } from './export/index.js';
import { loadLanguageId, TopicIntake } from './language.js';
import { FileLedger } from './ledger.js';
import { logger } from './logger.js';
import { observer } from './observability.js';
import { createRecognizer } from './stt.js';
import { ExpertVoices } from './voices.js';

export interface Services {
  cfg: Config;
  onten: Onten;
  experts: ExpertCatalog;
  synthesizer: SpeechSynthesizer;
  /** Server-side STT; null when clients transcribe on-device (`PEN_STT_PROVIDER=browser`). */
  recognizer: SpeechRecognizerFactory | null;
  voices: ExpertVoices;
  ledger: FileLedger;
  db: Connection;
  sessions: SessionRepository;
  participants: ParticipantRepository;
  billing: Billing;
  analytics: Analytics;
  intake: TopicIntake;
  modelFor(plan: PlanCode): LanguageModel;
  acquirer: KnowledgeAcquirer | null;
  costs: CostLedger;
  /** MP4 export queue (one render at a time per process). */
  exports: ExportJobs;
  downloadTokens: DownloadTokens;
  /** Null when ffmpeg + Chromium were found at boot; otherwise why exports are refused. */
  renderUnavailable: string | null;
}

/** In-memory cost ledger with daily totals; persisted to the data dir hourly by main. */
export class CostLedger implements CostMeter {
  private readonly byPurpose = new Map<
    string,
    { calls: number; usd: number; inputTokens: number; cachedTokens: number; outputTokens: number }
  >();
  record(usage: Usage & { purpose: string }): void {
    const e = this.byPurpose.get(usage.purpose) ?? {
      calls: 0,
      usd: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    };
    e.calls += 1;
    e.usd += usage.usd;
    e.inputTokens += usage.inputTokens;
    e.cachedTokens += usage.cachedTokens;
    e.outputTokens += usage.outputTokens;
    this.byPurpose.set(usage.purpose, e);
    logger.debug({ evt: 'llm.usage', ...usage });
  }
  snapshot() {
    return Object.fromEntries(this.byPurpose);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, '..', 'data');

export async function buildServices(
  cfg: Config,
  opts: { acquirerFactory?: (s: Omit<Services, 'acquirer'>) => KnowledgeAcquirer | null } = {},
): Promise<Services> {
  const onten = createOnten({ dataDir: join(cfg.PEN_DATA_DIR, 'onten') });
  const experts = ExpertCatalog.fromJson(
    JSON.parse(readFileSync(join(DATA_DIR, 'experts', 'catalog.json'), 'utf8')),
  );
  const costs = new CostLedger();

  const synthesizer: SpeechSynthesizer = (() => {
    switch (cfg.PEN_TTS_PROVIDER) {
      case 'fish-cloud': {
        if (!cfg.FISH_AUDIO_API_KEY)
          throw new Error('PEN_TTS_PROVIDER=fish-cloud requires FISH_AUDIO_API_KEY');
        return new FishCloudSynthesizer({
          apiKey: cfg.FISH_AUDIO_API_KEY,
          model: cfg.FISH_AUDIO_MODEL,
          onFirstChunk: (ms) => observer.event('tts.first_chunk_ms', { ms }),
        });
      }
      case 'fish-bridge':
        return new FishBridgeSynthesizer({ baseUrl: cfg.PEN_TTS_BRIDGE_URL });
      case 'silent':
        logger.warn('PEN_TTS_PROVIDER=silent: the expert will not be audible (development only)');
        return new SilentSynthesizer({ realtime: true });
    }
  })();

  const recognizer = createRecognizer(cfg);
  const voices = ExpertVoices.load(join(DATA_DIR, 'experts', 'voices.json'));
  const models = new Map<PlanCode, LanguageModel>();
  const modelFor = (plan: PlanCode): LanguageModel => {
    const cached = models.get(plan);
    if (cached) return cached;
    let model: LanguageModel;
    if (cfg.PEN_LLM_PROVIDER === 'fake') {
      logger.warn('PEN_LLM_PROVIDER=fake: scripted demo lessons only (development only)');
      model = new FakeLanguageModel(demoScripts.scripts, demoScripts.completions);
    } else {
      const key =
        plan === 'professional'
          ? cfg.OPENAI_API_KEY_PROFESSIONAL
          : plan === 'standard'
            ? cfg.OPENAI_API_KEY_STANDARD
            : cfg.OPENAI_API_KEY_FREE;
      if (!key)
        throw new Error(
          `No language-model key configured for plan "${plan}" (OPENAI_API_KEY_${plan.toUpperCase()})`,
        );
      model = new OpenAILanguageModel({
        apiKey: key,
        model: cfg.PEN_LLM_MODEL,
        ...(cfg.PEN_LLM_BASE_URL ? { baseURL: cfg.PEN_LLM_BASE_URL } : {}),
        ...(cfg.PEN_LLM_SERVICE_TIER ? { serviceTier: cfg.PEN_LLM_SERVICE_TIER } : {}),
        reasoningEffort: 'none',
        meter: costs,
        onInvalidEvent: (raw, error) =>
          observer.error('llm.invalid_event', error, { rawType: typeof raw }),
      });
    }
    models.set(plan, model);
    return model;
  };

  const ledger = new FileLedger(join(cfg.PEN_DATA_DIR, 'sessions'));
  const db = await connect(cfg.DATABASE_URL);
  const sessions = new SessionRepository(db.db);
  const participants = new ParticipantRepository(db.db);
  const billing = new Billing(cfg, participants);
  const analytics = new Analytics(cfg);
  await loadLanguageId();
  const intake = new TopicIntake(modelFor('free'), join(cfg.PEN_DATA_DIR, 'onten'));
  const renderer = new PlaywrightRenderer({
    baseUrl: cfg.PEN_RENDER_BASE_URL ?? cfg.PEN_PUBLIC_URL,
    allowedOrigins: [cfg.PEN_API_URL, cfg.PEN_PUBLIC_URL],
    ffmpegPath: cfg.PEN_FFMPEG_PATH,
    chromiumPath: cfg.PEN_CHROMIUM_PATH,
    chromiumArgs: cfg.PEN_CHROMIUM_ARGS?.split(/\s+/).filter(Boolean),
    ledger,
    onEvent: (name, data) => observer.event(name, data),
  });
  const availability = await renderer.available();
  const renderUnavailable = availability.ok ? null : availability.reason;
  if (renderUnavailable) logger.warn({ reason: renderUnavailable }, 'MP4 export disabled');
  const exports = new ExportJobs({
    sessionsDir: join(cfg.PEN_DATA_DIR, 'sessions'),
    renderer,
    onEvent: (name, data) => observer.event(name, data),
    onError: (area, error, data) => observer.error(area, error, data),
  });
  const downloadTokens = new DownloadTokens(cfg.PEN_JWT_SECRET);
  const base = {
    cfg,
    onten,
    experts,
    synthesizer,
    recognizer,
    voices,
    ledger,
    db,
    sessions,
    participants,
    billing,
    analytics,
    intake,
    modelFor,
    costs,
    exports,
    downloadTokens,
    renderUnavailable,
  };
  const acquirer = opts.acquirerFactory ? opts.acquirerFactory(base) : null;
  return { ...base, acquirer };
}
