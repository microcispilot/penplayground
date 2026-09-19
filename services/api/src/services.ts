import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KeyOwner, PlanCode } from '@pen/contracts';
import {
  type Connection,
  connect,
  ListRepository,
  ParticipantRepository,
  RuntimeConfigRepository,
  SessionRepository,
} from '@pen/db';
import {
  type CostMeter,
  FakeImageModel,
  FakeLanguageModel,
  type ImageModel,
  type LanguageModel,
  OpenAIImageModel,
  OpenAILanguageModel,
  type Usage,
} from '@pen/llm';
import { createOnten, type Onten } from '@pen/onten';
import {
  ExpertCatalog,
  FileLessonMemo,
  type IntentClassifier,
  type KnowledgeAcquirer,
  type LessonMemo,
  type SessionMetaJobs,
} from '@pen/session-engine';
import {
  CachingSynthesizer,
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
import { createIntentClassifier } from './intent.js';
import { loadLanguageId, TopicIntake } from './language.js';
import { FileLedger } from './ledger.js';
import { LiveKitRooms } from './livekit.js';
import { logger } from './logger.js';
import { FileSessionMetaCache } from './meta-cache.js';
import { captureWarning, observer } from './observability.js';
import { RuntimeConfigService, RuntimeConfigStore } from './runtime-config/index.js';
import { SpendBreaker } from './spend.js';
import { createRecognizer } from './stt.js';
import { FileThumbnailImageCache } from './thumbnail-cache.js';
import { createSessionMetaJobs, ThumbnailStore } from './thumbnails.js';
import { ExpertVoices } from './voices.js';

export interface Services {
  cfg: Config;
  /**
   * What this process is running on right now (ADR-0025): the compiled-in
   * defaults, overlaid with the stored document, overlaid with whatever the
   * environment pins. Reading one is a synchronous map lookup; nothing on a
   * hot path ever waits for it.
   */
  config: RuntimeConfigStore;
  /** Reading and changing that document, for the Settings screen. */
  runtimeConfig: RuntimeConfigService;
  onten: Onten;
  /**
   * Lessons this product has already taught, reused by the next learner of the
   * same topic, band, persona and language. Pen's own cache of Pen's own model
   * output — not an Onten capability (docs/ONTEN-BOUNDARY.md).
   */
  memo: LessonMemo;
  experts: ExpertCatalog;
  synthesizer: SpeechSynthesizer;
  /** The synthesis cache in front of the engine (ADR-0017); null when disabled. */
  ttsCache: CachingSynthesizer | null;
  /** Server-side STT; null when clients transcribe on-device (`PEN_STT_PROVIDER=browser`). */
  recognizer: SpeechRecognizerFactory | null;
  /**
   * The hosted intent classifier in front of the session model's own intent
   * call, for a room that is being built now; null when the provider is
   * `model` and the model does it, or when `jev` has no key to run on.
   *
   * A function, not a value: the provider is a per-session setting, so it is
   * read once as the room is built and that room keeps what it got — a change
   * in the dashboard never moves under a lesson in progress.
   */
  intentFor(): IntentClassifier | null;
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
  /** The image model for a host's plan — same key as `modelFor`, so a thumbnail bills where the lesson did. */
  imageFor(plan: PlanCode): ImageModel;
  /**
   * The platform's own model, on `OPENAI_API_KEY_PLATFORM`: work that belongs
   * to no learner — backfills, probes, prewarming. Never a session's work.
   * Null when that key is not configured.
   */
  platformModel: LanguageModel | null;
  /** The platform's own image model, same key and same rule. Null when it is not configured. */
  platformImage: ImageModel | null;
  acquirer: KnowledgeAcquirer | null;
  /** Web search backend name (searxng | tavily | exa | none), for pricing what a pack hit saved. */
  searchProvider: string;
  costs: CostLedger;
  /** Free-plan video ad demand and the per-session revenue estimate (ADR-0014). */
  ads: AdEconomics;
  /** The day's provider spend and the circuit breaker in front of it (ADR-0016). */
  spend: SpendBreaker;
  /** MP4 export queue (one render at a time per process). */
  exports: ExportJobs;
  downloadTokens: DownloadTokens;
  /** Null when ffmpeg + Chromium were found at boot; otherwise why exports are refused. */
  renderUnavailable: string | null;
  /** Human-to-human audio in rooms; null until LIVEKIT_URL/KEY/SECRET are configured. */
  livekit: LiveKitRooms | null;
  /** Session thumbnails on disk: the generation and every size downscaled from it (ADR-0013, ADR-0021). */
  thumbnails: ThumbnailStore;
  /** Card copy already written, keyed by the lesson memo's scope (ADR-0013). */
  metaCache: FileSessionMetaCache;
  /** Thumbnails already generated, keyed by the same scope (ADR-0021). */
  thumbnailCache: FileThumbnailImageCache;
  /** Background card copy + thumbnail jobs; rooms enqueue once their plan exists. */
  meta: SessionMetaJobs;
}

/**
 * In-memory cost ledger with daily totals, across every provider call the
 * process makes — model and image alike, keyed by `purpose`. Persisted to the
 * data dir hourly by main. A session's own spend is its ledger's business
 * (ADR-0011); this is the house account's view of the same calls.
 */
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
    // One event name for every priced call, model and image alike; `purpose` says which.
    logger.debug({ evt: 'provider.usage', ...usage });
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
  const memo = new FileLessonMemo(join(cfg.PEN_DATA_DIR, 'onten'));
  const experts = ExpertCatalog.fromJson(
    JSON.parse(readFileSync(join(DATA_DIR, 'experts', 'catalog.json'), 'utf8')),
  );
  const costs = new CostLedger();

  const ledger = new FileLedger(join(cfg.PEN_DATA_DIR, 'sessions'));
  const db = await connect(cfg.DATABASE_URL, {
    log: (message, detail) => logger.warn({ evt: message, ...detail }),
  });
  const sessions = new SessionRepository(db.db);
  const participants = new ParticipantRepository(db.db);
  const lists = new ListRepository(db.db);

  /**
   * The runtime configuration comes first, because everything below it is
   * built from settings (ADR-0025). `start()` is awaited so the process boots
   * on the document that is actually in force rather than on the defaults and
   * then changing its mind a poll later. A database that cannot be read here
   * is not fatal: the store falls back to its last known good copy on disk,
   * and to the compiled-in defaults only if it has never seen one.
   */
  const runtimeConfigRepo = new RuntimeConfigRepository(db.db);
  const config = new RuntimeConfigStore({ cfg, source: runtimeConfigRepo });
  await config.start();
  const runtimeConfig = new RuntimeConfigService(runtimeConfigRepo, config, async (id) => {
    const row = await participants.get(id);
    return row?.name ?? null;
  });
  logger.info(
    {
      evt: 'config.ready',
      revision: config.revision,
      stale: config.stale,
      ...config.snapshot(),
    },
    'runtime configuration resolved',
  );

  const ads = new AdEconomics(cfg, config, costs);

  const engine: SpeechSynthesizer = (() => {
    switch (config.get('PEN_TTS_PROVIDER')) {
      case 'fish-cloud': {
        if (!cfg.FISH_AUDIO_API_KEY)
          throw new Error('PEN_TTS_PROVIDER=fish-cloud requires FISH_AUDIO_API_KEY');
        return new FishCloudSynthesizer({
          apiKey: cfg.FISH_AUDIO_API_KEY,
          model: config.get('FISH_AUDIO_MODEL'),
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

  /**
   * Zero redundant work (ADR-0017): a lesson served from the memo says the very
   * same sentences, so they are synthesised once and replayed from disk after
   * that. The cache is a wrapper, so the pipeline above it is unchanged.
   */
  const ttsCacheMb = config.get('PEN_TTS_CACHE_MB');
  const ttsCache =
    ttsCacheMb > 0
      ? new CachingSynthesizer({
          inner: engine,
          dir: join(cfg.PEN_DATA_DIR, 'lesson-voice'),
          maxBytes: ttsCacheMb * 1024 * 1024,
          onEvent: (name, data) => observer.event(name, data),
        })
      : null;
  const synthesizer: SpeechSynthesizer = ttsCache ?? engine;
  if (ttsCache)
    logger.info(
      { evt: 'tts.cache_on', maxMb: ttsCacheMb, says: ttsCache.snapshot().says },
      'lesson voice store ready',
    );
  else logger.info({ evt: 'tts.cache_off' }, 'lesson voice store disabled (PEN_TTS_CACHE_MB=0)');

  // Both read per decision, so the cap can be raised or dropped during an
  // incident without a deploy (ADR-0025).
  const spend = new SpendBreaker({
    capUsd: () => config.get('PEN_DAILY_SPEND_CAP_USD'),
    paidMultiple: () => config.get('PEN_DAILY_SPEND_PAID_MULTIPLE'),
    onWarning: ({ usd, capUsd, fraction }) =>
      captureWarning('spend.threshold', 'Daily provider spend passed 80 % of the cap', {
        usd: Math.round(usd * 100) / 100,
        capUsd,
        fraction: Math.round(fraction * 100) / 100,
      }),
  });
  if (spend.enabled) {
    const recovered = spend.rebuild(join(cfg.PEN_DATA_DIR, 'sessions'));
    logger.info(
      { evt: 'spend.ready', capUsd: spend.capUsd, ...recovered },
      "today's spend recovered from the ledgers",
    );
  } else logger.warn({ evt: 'spend.off' }, 'daily spend cap disabled (PEN_DAILY_SPEND_CAP_USD=0)');

  const recognizer = createRecognizer(cfg, config.get('PEN_STT_PROVIDER'));
  // Priced into the house account like every other provider call; the session's
  // own ledger gets its `intent` stage and cost line from the room's wrapper.
  // Memoised per (provider, model), so a room being built pays a map lookup.
  const intentFor = createIntentClassifier(cfg, config, costs);
  const voices = ExpertVoices.load(join(DATA_DIR, 'experts', 'voices.json'));
  /** Which of the four keys a call runs on (`KeyOwner` in contracts says why they never fall back). */
  const keyFor = (owner: KeyOwner): string | undefined =>
    owner === 'platform'
      ? cfg.OPENAI_API_KEY_PLATFORM
      : owner === 'professional'
        ? cfg.OPENAI_API_KEY_PROFESSIONAL
        : owner === 'standard'
          ? cfg.OPENAI_API_KEY_STANDARD
          : cfg.OPENAI_API_KEY_FREE;

  // The adapters are built once and cached by (key owner, model name), so a
  // model setting that changes simply builds one more adapter rather than
  // rebuilding the world — and a room that already holds one keeps it.
  const serviceTier = config.get('PEN_LLM_SERVICE_TIER');
  const models = new Map<string, LanguageModel>();
  /** One adapter per (key owner, model name); the fake provider serves every request from its scripts. */
  const buildModel = (owner: KeyOwner, modelName: string): LanguageModel => {
    const cacheId = `${owner}:${modelName}`;
    const cached = models.get(cacheId);
    if (cached) return cached;
    let model: LanguageModel;
    if (config.get('PEN_LLM_PROVIDER') === 'fake') {
      if (models.size === 0)
        logger.warn('PEN_LLM_PROVIDER=fake: scripted demo lessons only (development only)');
      model = new FakeLanguageModel(demoScripts.scripts, demoScripts.completions);
    } else {
      const key = keyFor(owner);
      if (!key)
        throw new Error(
          `No language-model key configured for "${owner}" (OPENAI_API_KEY_${owner.toUpperCase()})`,
        );
      model = new OpenAILanguageModel({
        apiKey: key,
        model: modelName,
        ...(cfg.PEN_LLM_BASE_URL ? { baseURL: cfg.PEN_LLM_BASE_URL } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        reasoningEffort: 'none',
        meter: costs,
        onInvalidEvent: (raw, error) =>
          observer.error('llm.invalid_event', error, { rawType: typeof raw }),
      });
    }
    models.set(cacheId, model);
    return model;
  };
  /** Read per call, and a room calls it once as it is built (ADR-0025). */
  const modelFor = (plan: PlanCode): LanguageModel => buildModel(plan, config.get('PEN_LLM_MODEL'));

  const imageModels = new Map<string, ImageModel>();
  /**
   * One image adapter per (key owner, model). Same keys, same rule: a
   * learner's picture bills to their host's plan. Keyed by the model too,
   * because the model is a runtime setting and two of them can be live in one
   * process while jobs started before the change finish.
   */
  const buildImage = (owner: KeyOwner): ImageModel => {
    const imageModel = config.get('PEN_IMAGE_MODEL');
    const cacheId = `${owner}:${imageModel}`;
    const cached = imageModels.get(cacheId);
    if (cached) return cached;
    let model: ImageModel;
    if (config.get('PEN_LLM_PROVIDER') === 'fake') {
      model = new FakeImageModel();
    } else {
      const key = keyFor(owner);
      if (!key)
        throw new Error(
          `No image key configured for "${owner}" (OPENAI_API_KEY_${owner.toUpperCase()})`,
        );
      model = new OpenAIImageModel({
        apiKey: key,
        model: imageModel,
        ...(cfg.PEN_LLM_BASE_URL ? { baseURL: cfg.PEN_LLM_BASE_URL } : {}),
        meter: costs,
      });
    }
    imageModels.set(cacheId, model);
    return model;
  };
  const imageFor = (plan: PlanCode): ImageModel => buildImage(plan);
  // Null when the key is absent, so a deployment without it still boots and the
  // scripts that need it say why they cannot run instead of billing a learner.
  const hasPlatformKey =
    config.get('PEN_LLM_PROVIDER') === 'fake' || Boolean(cfg.OPENAI_API_KEY_PLATFORM);
  const platformModel = hasPlatformKey
    ? buildModel('platform', config.get('PEN_LLM_OUTLINE_MODEL'))
    : null;
  const platformImage = hasPlatformKey ? buildImage('platform') : null;
  if (!platformModel)
    logger.info(
      'OPENAI_API_KEY_PLATFORM is not set: backfills and probes have no key of their own',
    );

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
  const thumbnails = new ThumbnailStore(join(cfg.PEN_DATA_DIR, 'sessions'));
  // The card of a lesson that was already taught (same topic, band, persona, language) is
  // reused rather than written again — the lesson memo's rule, applied to the card (ADR-0013)
  // and to its picture (ADR-0021), so a repeat topic never pays for either twice.
  const metaCache = new FileSessionMetaCache(join(cfg.PEN_DATA_DIR, 'onten'));
  const thumbnailCache = new FileThumbnailImageCache(join(cfg.PEN_DATA_DIR, 'onten'));
  /**
   * The card copy runs on the cheap outline model and the picture on
   * `gpt-image-1`, both on the HOST'S plan key — the same one that taught the
   * lesson. The copy call also opens with the plan call's persona prefix, so
   * when the outline model is the session model (the default) it hits the
   * provider's prompt cache.
   */
  const meta = createSessionMetaJobs({
    // Both read when the job runs, not when the queue is made: a card written
    // an hour after a restart uses the setting in force then.
    modelFor: (owner) => buildModel(owner, config.get('PEN_LLM_OUTLINE_MODEL')),
    imageFor: buildImage,
    quality: () => config.get('PEN_THUMBNAIL_QUALITY'),
    store: thumbnails,
    sessions,
    cache: metaCache,
    imageCache: thumbnailCache,
  });
  const base = {
    cfg,
    config,
    runtimeConfig,
    onten,
    memo,
    searchProvider,
    experts,
    synthesizer,
    ttsCache,
    recognizer,
    intentFor,
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
    imageFor,
    platformModel,
    platformImage,
    costs,
    ads,
    spend,
    exports,
    downloadTokens,
    renderUnavailable,
    livekit,
    thumbnails,
    metaCache,
    thumbnailCache,
    meta,
  };
  const acquirer = opts.acquirerFactory ? opts.acquirerFactory(base) : null;
  return { ...base, acquirer };
}
