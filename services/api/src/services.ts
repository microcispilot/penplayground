import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanCode } from '@pen/contracts';
import {
  type Connection,
  connect,
  ListRepository,
  ParticipantRepository,
  SessionRepository,
} from '@pen/db';
import {
  type CostMeter,
  FakeLanguageModel,
  type LanguageModel,
  OpenAILanguageModel,
  type Usage,
} from '@pen/llm';
import { createOnten, type Onten } from '@pen/onten';
import { ExpertCatalog, type KnowledgeAcquirer, type SessionMetaJobs } from '@pen/session-engine';
import {
  FishBridgeSynthesizer,
  FishCloudSynthesizer,
  SilentSynthesizer,
  type SpeechRecognizerFactory,
  type SpeechSynthesizer,
} from '@pen/voice';
import { AdEconomics } from './ads.js';
import { Analytics } from './analytics.js';
import { Billing } from './billing.js';
import type { Config } from './config.js';
import { demoScripts } from './demo-scripts.js';
import { DownloadTokens, ExportJobs, PlaywrightRenderer } from './export/index.js';
import { GoogleLibraryVerifier, GoogleSignIn, type GoogleTokenVerifier } from './google.js';
import { loadLanguageId, TopicIntake } from './language.js';
import { FileLedger } from './ledger.js';
import { LiveKitRooms } from './livekit.js';
import { logger } from './logger.js';
import { FileSessionMetaCache } from './meta-cache.js';
import { observer } from './observability.js';
import { createRecognizer } from './stt.js';
import { createSessionMetaJobs, loadThumbnailFont, ThumbnailStore } from './thumbnails.js';
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
  /** Saved / liked / history per participant (ADR-0015). */
  lists: ListRepository;
  billing: Billing;
  /** Google sign-in; null until `GOOGLE_CLIENT_ID` is configured. */
  google: GoogleSignIn | null;
  analytics: Analytics;
  intake: TopicIntake;
  modelFor(plan: PlanCode): LanguageModel;
  acquirer: KnowledgeAcquirer | null;
  /** Web search backend name (searxng | tavily | exa | none), for pricing what a pack hit saved. */
  searchProvider: string;
  costs: CostLedger;
  /** Free-plan video ad demand and the per-session revenue estimate (ADR-0014). */
  ads: AdEconomics;
  /** MP4 export queue (one render at a time per process). */
  exports: ExportJobs;
  downloadTokens: DownloadTokens;
  /** Null when ffmpeg + Chromium were found at boot; otherwise why exports are refused. */
  renderUnavailable: string | null;
  /** Human-to-human audio in rooms; null until LIVEKIT_URL/KEY/SECRET are configured. */
  livekit: LiveKitRooms | null;
  /** Session thumbnails on disk (ADR-0013). */
  thumbnails: ThumbnailStore;
  /** Cards already drawn, keyed by the lesson memo's scope (ADR-0013). */
  metaCache: FileSessionMetaCache;
  /** The cheap model the card + sketch call runs on (the backfill uses the same one). */
  metaModel: LanguageModel;
  /** Background card copy + sketch jobs; rooms enqueue once their plan exists. */
  meta: SessionMetaJobs;
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
  /** A revenue line: negative usd under its own purpose (e.g. `ads`), so totals net out. */
  credit(purpose: string, usd: number): void {
    const e = this.byPurpose.get(purpose) ?? {
      calls: 0,
      usd: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    };
    e.calls += 1;
    e.usd -= usd;
    this.byPurpose.set(purpose, e);
    logger.debug({ evt: 'revenue.credit', purpose, usd });
  }
  snapshot() {
    return Object.fromEntries(this.byPurpose);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, '..', 'data');

export async function buildServices(
  cfg: Config,
  opts: {
    acquirerFactory?: (s: Omit<Services, 'acquirer'>) => KnowledgeAcquirer | null;
    /** Google ID-token verification seam (tests inject a fake; production uses Google's library). */
    googleVerifier?: GoogleTokenVerifier;
  } = {},
): Promise<Services> {
  const onten = createOnten({ dataDir: join(cfg.PEN_DATA_DIR, 'onten') });
  const experts = ExpertCatalog.fromJson(
    JSON.parse(readFileSync(join(DATA_DIR, 'experts', 'catalog.json'), 'utf8')),
  );
  const costs = new CostLedger();
  const ads = new AdEconomics(cfg, costs);

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
  const models = new Map<string, LanguageModel>();
  /** One adapter per (plan key, model name); the fake provider serves every request from its scripts. */
  const buildModel = (plan: PlanCode, modelName: string): LanguageModel => {
    const cacheId = `${plan}:${modelName}`;
    const cached = models.get(cacheId);
    if (cached) return cached;
    let model: LanguageModel;
    if (cfg.PEN_LLM_PROVIDER === 'fake') {
      if (models.size === 0)
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
        model: modelName,
        ...(cfg.PEN_LLM_BASE_URL ? { baseURL: cfg.PEN_LLM_BASE_URL } : {}),
        ...(cfg.PEN_LLM_SERVICE_TIER ? { serviceTier: cfg.PEN_LLM_SERVICE_TIER } : {}),
        reasoningEffort: 'none',
        meter: costs,
        onInvalidEvent: (raw, error) =>
          observer.error('llm.invalid_event', error, { rawType: typeof raw }),
      });
    }
    models.set(cacheId, model);
    return model;
  };
  const modelFor = (plan: PlanCode): LanguageModel => buildModel(plan, cfg.PEN_LLM_MODEL);

  const ledger = new FileLedger(join(cfg.PEN_DATA_DIR, 'sessions'));
  const db = await connect(cfg.DATABASE_URL, {
    log: (message, detail) => logger.warn({ evt: message, ...detail }),
  });
  const sessions = new SessionRepository(db.db);
  const participants = new ParticipantRepository(db.db);
  const lists = new ListRepository(db.db);
  const billing = new Billing(cfg, participants);
  const googleVerifier =
    opts.googleVerifier ??
    (cfg.GOOGLE_CLIENT_ID ? new GoogleLibraryVerifier(cfg.GOOGLE_CLIENT_ID) : null);
  const google = googleVerifier
    ? new GoogleSignIn(googleVerifier, participants, lists, cfg.PEN_DEV_PLAN ?? 'free')
    : null;
  if (!google) logger.info('google sign-in disabled: set GOOGLE_CLIENT_ID');
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
    // Without a renderer a queued job would only fail again; leave it "interrupted" for the client.
    resumeQueued: renderUnavailable === null,
    onEvent: (name, data) => observer.event(name, data),
    onError: (area, error, data) => observer.error(area, error, data),
  });
  // Jobs that were waiting when the previous process stopped render now instead of reading "interrupted".
  const resumed = exports.resume();
  if (resumed.length > 0) logger.info({ count: resumed.length }, 'export jobs resumed');
  const downloadTokens = new DownloadTokens(cfg.PEN_JWT_SECRET);
  const livekit =
    cfg.LIVEKIT_URL && cfg.LIVEKIT_API_KEY && cfg.LIVEKIT_API_SECRET
      ? new LiveKitRooms({
          url: cfg.LIVEKIT_URL,
          apiUrl: cfg.LIVEKIT_API_URL,
          apiKey: cfg.LIVEKIT_API_KEY,
          apiSecret: cfg.LIVEKIT_API_SECRET,
        })
      : null;
  if (!livekit)
    logger.warn('rooms audio disabled: set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET');
  const searchProvider = cfg.SEARXNG_URL
    ? 'searxng'
    : cfg.TAVILY_API_KEY
      ? 'tavily'
      : cfg.EXA_API_KEY
        ? 'exa'
        : 'none';
  const thumbnails = new ThumbnailStore(join(cfg.PEN_DATA_DIR, 'sessions'), loadThumbnailFont());
  // The card of a lesson that was already taught (same topic, band, persona, language) is
  // reused rather than drawn again — the lesson memo's rule, applied to the card (ADR-0013).
  const metaCache = new FileSessionMetaCache(join(cfg.PEN_DATA_DIR, 'onten'));
  // Card copy and sketches are house-account work on the cheapest model; when it is the session
  // model (the default) the plan call's persona prefix is already in the prompt cache.
  const metaModel = buildModel('free', cfg.PEN_LLM_OUTLINE_MODEL);
  const meta = createSessionMetaJobs({
    model: metaModel,
    store: thumbnails,
    sessions,
    cache: metaCache,
  });
  const base = {
    cfg,
    onten,
    searchProvider,
    experts,
    synthesizer,
    recognizer,
    voices,
    ledger,
    db,
    sessions,
    participants,
    lists,
    billing,
    google,
    analytics,
    intake,
    modelFor,
    costs,
    ads,
    exports,
    downloadTokens,
    renderUnavailable,
    livekit,
    thumbnails,
    metaCache,
    metaModel,
    meta,
  };
  const acquirer = opts.acquirerFactory ? opts.acquirerFactory(base) : null;
  return { ...base, acquirer };
}
