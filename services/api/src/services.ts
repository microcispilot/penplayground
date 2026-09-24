import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KeyOwner, PlanCode } from '@pen/contracts';
import { FeatureRulesDocument, type VoiceEngine } from '@pen/contracts';
import {
  AuthChallengeRepository,
  CommentRepository,
  type Connection,
  connect,
  FeatureFlagsRepository,
  ListRepository,
  ParticipantRepository,
  ReportRepository,
  RuntimeConfigRepository,
  SessionRepository,
  StatsRepository,
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
  type Grader,
  type IntentClassifier,
  type KnowledgeAcquirer,
  type LessonMemo,
  type SessionMetaJobs,
} from '@pen/session-engine';
import {
  CachingSynthesizer,
  CartesiaSynthesizer,
  FishBridgeSynthesizer,
  FishCloudSynthesizer,
  SilentSynthesizer,
  type SpeechRecognizerFactory,
  type SpeechSynthesizer,
} from '@pen/voice';
import { AdEconomics } from './ads.js';
import { Analytics } from './analytics.js';
import { createMailer, type Mailer } from './auth/mailer.js';
import { Billing } from './billing.js';
import type { Config } from './config.js';
import { demoScripts } from './demo-scripts.js';
import { DownloadTokens, ExportJobs, PlaywrightRenderer } from './export/index.js';
import { FeatureFlagsService, FeatureStore, featureFlagsCachePath } from './features/index.js';
import {
  type GoogleCodeExchanger,
  GoogleLibraryExchanger,
  GoogleLibraryVerifier,
  GoogleSignIn,
  type GoogleTokenVerifier,
} from './google.js';
import { createGrader, createIntentClassifier } from './intent.js';
import { loadLanguageId, TopicIntake } from './language.js';
import { FileLedger } from './ledger.js';
import { LiveKitRooms } from './livekit.js';
import { logger } from './logger.js';
import { FileSessionMetaCache } from './meta-cache.js';
import { captureWarning, observer } from './observability.js';
import { RuntimeConfigService, RuntimeConfigStore } from './runtime-config/index.js';
import { SpendBreaker } from './spend.js';
import { StatsDeriver } from './stats/deriver.js';
import { VisitIngest } from './stats/visits.js';
import { createRecognizer } from './stt.js';
import { FileThumbnailImageCache } from './thumbnail-cache.js';
import { createSessionMetaJobs, ThumbnailStore } from './thumbnails.js';
import { type VoiceEngineParts, VoiceService } from './voice/service.js';
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
  /**
   * Which parts of the product each plan gets on each platform (ADR-0036).
   * Read as a session is admitted and as a room is built; a synchronous
   * lookup like `config`, and the last known good document when the store
   * cannot be read.
   */
  features: FeatureStore;
  /** Reading and changing that document, for the Features screen. */
  featureFlags: FeatureFlagsService;
  /**
   * The language-model provider the adapters were actually built with. A
   * `restart` setting, so this — not the store — is what `/api/health` and
   * the readiness probe must report: the store can already be one save ahead
   * of the objects in this process.
   */
  llmProvider: Config['PEN_LLM_PROVIDER'];
  onten: Onten;
  /**
   * Lessons this product has already taught, reused by the next learner of the
   * same topic, band, persona and language. Pen's own cache of Pen's own model
   * output — not an Onten capability (docs/ONTEN-BOUNDARY.md).
   */
  memo: LessonMemo;
  experts: ExpertCatalog;
  /** The engines this server speaks with, and the one a session gets (ADR-0048). */
  voice: VoiceService;
  /** The synthesis cache in front of each engine (ADR-0017); empty when disabled. */
  ttsCaches: Partial<Record<VoiceEngine, CachingSynthesizer>>;
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
  /** The hosted check-in grader for a room being built now (ADR-0039), or null for the model path. */
  graderFor(): Grader | null;
  ledger: FileLedger;
  db: Connection;
  sessions: SessionRepository;
  participants: ParticipantRepository;
  authChallenges: AuthChallengeRepository;
  /**
   * How mail leaves. Built here rather than in `buildApp` so the production
   * refusal — no SMTP configured — happens at boot instead of on the first
   * person who tries to sign up, and so a test can put a capturing one in its
   * place without reaching into the route.
   */
  mailer: Mailer;
  /** Saved / liked / history per participant (ADR-0015). */
  lists: ListRepository;
  /** Comments under a session (ADR-0044). */
  comments: CommentRepository;
  /** Writing the statistics: derived session rows, visits, plan history (ADR-0027). */
  stats: StatsRepository;
  /** Reading them: every aggregate the owner's dashboard asks for, as SQL. */
  reports: ReportRepository;
  /** Rolls a finished session's ledger into rows, off the hot path and never fatally. */
  deriver: StatsDeriver;
  /** Counts visits — signed in or not — and the engaged time they spend. */
  visits: VisitIngest;
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
    googleExchanger?: GoogleCodeExchanger;
    /**
     * Feature rules this process starts on, over whatever the store holds
     * (ADR-0036). A seam for tests and scripts that need a deployment whose
     * flags differ from the compiled-in ones — a free learner allowed to
     * have a topic prepared, say — without a database row to put them in.
     */
    flags?: FeatureRulesDocument;
  } = {},
): Promise<Services> {
  const onten = createOnten({ dataDir: join(cfg.PEN_DATA_DIR, 'onten') });
  // A memo file this process cannot read or write is every lesson it has
  // taught, at risk: it goes to Sentry rather than to the bill.
  const memo = new FileLessonMemo(join(cfg.PEN_DATA_DIR, 'onten'), {
    onError: (area, error) => observer.error(area, error),
  });
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
  const authChallenges = new AuthChallengeRepository(db.db);
  const mailer = createMailer({
    production: cfg.NODE_ENV === 'production',
    smtp: {
      host: cfg.PEN_SMTP_HOST,
      port: cfg.PEN_SMTP_PORT,
      username: cfg.PEN_SMTP_USERNAME,
      password: cfg.PEN_SMTP_PASSWORD,
      from: cfg.PEN_SMTP_FROM,
    },
  });
  const lists = new ListRepository(db.db);
  const comments = new CommentRepository(db.db);
  /** Statistics and reports (ADR-0027): one repository writes, the other reads. */
  const stats = new StatsRepository(db.db);
  const reports = new ReportRepository(db.db);

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
  const runtimeConfig = new RuntimeConfigService(
    runtimeConfigRepo,
    config,
    cfg,
    async (id) => (await participants.get(id))?.name ?? null,
    (area, error) => observer.error(area, error),
  );
  logger.info(
    {
      evt: 'config.ready',
      revision: config.revision,
      stale: config.stale,
      ...config.snapshot(),
    },
    'runtime configuration resolved',
  );

  /**
   * The feature flags, right behind the settings and for the same reasons:
   * the first session admitted must be judged by the document in force, not
   * by the compiled-in rules with a change arriving a poll later.
   */
  const featureFlagsRepo = new FeatureFlagsRepository(db.db);
  // A test deployment's pinned flags (`PEN_FEATURE_OVERLAY`, refused in
  // production) under the test seam's, which wins where both speak.
  const envOverlay: FeatureRulesDocument = cfg.PEN_FEATURE_OVERLAY
    ? FeatureRulesDocument.parse(JSON.parse(cfg.PEN_FEATURE_OVERLAY))
    : {};
  const overlay = { ...envOverlay, ...(opts.flags ?? {}) };
  const features = new FeatureStore({
    source: featureFlagsRepo,
    path: featureFlagsCachePath(cfg.PEN_DATA_DIR),
    pollMs: cfg.PEN_RUNTIME_CONFIG_POLL_MS,
    ...(Object.keys(overlay).length > 0 ? { overlay } : {}),
  });
  await features.start();
  const featureFlags = new FeatureFlagsService(
    featureFlagsRepo,
    features,
    async (id) => (await participants.get(id))?.name ?? null,
    (area, error) => observer.error(area, error),
  );
  logger.info(
    { evt: 'features.ready', revision: features.revision, stale: features.stale },
    'feature flags resolved',
  );

  const ads = new AdEconomics(cfg, config, costs);

  /**
   * The voices (ADR-0048). Each cloud engine this server holds a key for is
   * built once, behind its own store of taught lessons (ADR-0017: a lesson
   * served from the memo says the very same sentences, so they are
   * synthesised once and replayed from disk after that — per engine, since
   * a take is one engine's audio). The `voice_engine` setting then picks one
   * per session. The single-engine development providers answer to every
   * engine name, so the setting resolves without a fallback in a checkout.
   */
  const ttsCacheMb = config.get('PEN_TTS_CACHE_MB');
  const ttsCaches: Partial<Record<VoiceEngine, CachingSynthesizer>> = {};
  const voiceStore = (engine: VoiceEngine, inner: SpeechSynthesizer): SpeechSynthesizer => {
    if (ttsCacheMb <= 0) return inner;
    const dir = join(cfg.PEN_DATA_DIR, `lesson-voice-${engine}`);
    // Before ADR-0048 the one store was Fish's, at `lesson-voice`: it keeps its takes under its own name.
    if (engine === 'fish' && !existsSync(dir) && existsSync(join(cfg.PEN_DATA_DIR, 'lesson-voice')))
      renameSync(join(cfg.PEN_DATA_DIR, 'lesson-voice'), dir);
    const cache = new CachingSynthesizer({
      inner,
      dir,
      maxBytes: ttsCacheMb * 1024 * 1024,
      onEvent: (name, data) => observer.event(name, { ...data, engine }),
    });
    ttsCaches[engine] = cache;
    logger.info(
      { evt: 'tts.cache_on', engine, maxMb: ttsCacheMb, says: cache.snapshot().says },
      'lesson voice store ready',
    );
    return cache;
  };
  const fishVoices = ExpertVoices.load(join(DATA_DIR, 'experts', 'voices.fish.json'), 'fish');
  const cartesiaVoices = ExpertVoices.load(
    join(DATA_DIR, 'experts', 'voices.cartesia.json'),
    'cartesia',
  );
  const engines: Partial<Record<VoiceEngine, VoiceEngineParts>> = {};
  switch (config.get('PEN_TTS_PROVIDER')) {
    case 'cloud': {
      if (cfg.CARTESIA_API_KEY)
        engines.cartesia = {
          synthesizer: voiceStore(
            'cartesia',
            new CartesiaSynthesizer({
              apiKey: cfg.CARTESIA_API_KEY,
              model: config.get('CARTESIA_MODEL'),
              onFirstChunk: (ms) =>
                observer.event('tts.first_chunk_ms', { ms, engine: 'cartesia' }),
            }),
          ),
          voices: cartesiaVoices,
        };
      if (cfg.FISH_AUDIO_API_KEY)
        engines.fish = {
          synthesizer: voiceStore(
            'fish',
            new FishCloudSynthesizer({
              apiKey: cfg.FISH_AUDIO_API_KEY,
              model: config.get('FISH_AUDIO_MODEL'),
              onFirstChunk: (ms) => observer.event('tts.first_chunk_ms', { ms, engine: 'fish' }),
            }),
          ),
          voices: fishVoices,
        };
      if (!engines.cartesia && !engines.fish)
        throw new Error('PEN_TTS_PROVIDER=cloud requires CARTESIA_API_KEY or FISH_AUDIO_API_KEY');
      break;
    }
    case 'fish-bridge': {
      const bridge = {
        synthesizer: new FishBridgeSynthesizer({ baseUrl: cfg.PEN_TTS_BRIDGE_URL }),
        voices: fishVoices,
      };
      engines.fish = bridge;
      engines.cartesia = bridge;
      break;
    }
    case 'silent': {
      logger.warn('PEN_TTS_PROVIDER=silent: the expert will not be audible (development only)');
      const silent = { synthesizer: new SilentSynthesizer({ realtime: true }), voices: fishVoices };
      engines.fish = silent;
      engines.cartesia = silent;
      break;
    }
  }
  const voice = new VoiceService({
    engines,
    policy: (who) => features.setting('voice_engine', who),
    onFallback: ({ wanted, used, who }) => {
      logger.warn(
        { evt: 'voice.engine_fallback', wanted, used, plan: who.plan, platform: who.platform },
        'the voice engine the setting names is not configured here; speaking with another',
      );
      observer.event('voice.engine_fallback', {
        wanted,
        used,
        plan: who.plan,
        platform: who.platform,
      });
    },
  });
  logger.info({ evt: 'voice.ready', engines: voice.available() }, 'voice engines ready');
  if (ttsCacheMb <= 0)
    logger.info({ evt: 'tts.cache_off' }, 'lesson voice store disabled (PEN_TTS_CACHE_MB=0)');

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
  // Recovered whatever the cap says right now: the cap is a runtime setting
  // (ADR-0025), and a breaker armed later in the day must not believe the day
  // started clean. Counting costs nothing when the cap is 0.
  const recovered = spend.rebuild(join(cfg.PEN_DATA_DIR, 'sessions'));
  logger.info(
    { evt: 'spend.ready', capUsd: spend.capUsd, enabled: spend.enabled, ...recovered },
    "today's spend recovered from the ledgers",
  );
  if (!spend.enabled)
    logger.warn({ evt: 'spend.off' }, 'daily spend cap disabled (PEN_DAILY_SPEND_CAP_USD=0)');

  const recognizer = createRecognizer(cfg, config.get('PEN_STT_PROVIDER'));
  // Priced into the house account like every other provider call; the session's
  // own ledger gets its `intent` stage and cost line from the room's wrapper.
  // Memoised per (provider, model), so a room being built pays a map lookup.
  const intentFor = createIntentClassifier(cfg, config, costs);
  const graderFor = createGrader(cfg, config, costs);
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
  /**
   * Both read once, here, because both are `restart` settings and the
   * adapters below are cached. Reading the provider per call would make it a
   * live switch that the cache key does not include — one save could put
   * `fake` lessons in front of a paying learner without a restart, and
   * clearing it on a box with no provider key would make room creation throw.
   */
  const serviceTier = config.get('PEN_LLM_SERVICE_TIER');
  const llmProvider = config.get('PEN_LLM_PROVIDER');
  const models = new Map<string, LanguageModel>();
  /** One adapter per (key owner, model name); the fake provider serves every request from its scripts. */
  const buildModel = (owner: KeyOwner, modelName: string): LanguageModel => {
    const cacheId = `${owner}:${modelName}`;
    const cached = models.get(cacheId);
    if (cached) return cached;
    let model: LanguageModel;
    if (llmProvider === 'fake') {
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
    if (llmProvider === 'fake') {
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
  //
  // These two bind their model at boot on purpose, and it is the one place a
  // model setting is not read per use: they belong to no learner and no
  // session, and every caller is a short-lived script (backfill, probe,
  // prewarm) that boots, does its work on the settings in force when it
  // started, and exits.
  const hasPlatformKey = llmProvider === 'fake' || Boolean(cfg.OPENAI_API_KEY_PLATFORM);
  const platformModel = hasPlatformKey
    ? buildModel('platform', config.get('PEN_LLM_OUTLINE_MODEL'))
    : null;
  const platformImage = hasPlatformKey ? buildImage('platform') : null;
  if (!platformModel)
    logger.info(
      'OPENAI_API_KEY_PLATFORM is not set: backfills and probes have no key of their own',
    );

  const billing = new Billing(cfg, participants, stats);
  const googleVerifier =
    opts.googleVerifier ??
    (cfg.GOOGLE_CLIENT_ID ? new GoogleLibraryVerifier(cfg.GOOGLE_CLIENT_ID) : null);
  const googleExchanger =
    opts.googleExchanger ??
    (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET
      ? new GoogleLibraryExchanger(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET)
      : null);
  const google = googleVerifier
    ? new GoogleSignIn(
        googleVerifier,
        participants,
        lists,
        cfg.PEN_DEV_PLAN ?? 'free',
        googleExchanger,
      )
    : null;
  if (!google) logger.info('google sign-in disabled: set GOOGLE_CLIENT_ID');
  else if (!googleExchanger)
    logger.warn(
      'google sign-in: GOOGLE_CLIENT_SECRET is not set, so the app’s own Continue with Google (the code flow) will be refused; only ID tokens are accepted',
    );
  const analytics = new Analytics(cfg);
  // Finished sessions are queued here and derived by `main`'s drain loop,
  // never inline with a room's own teardown (ADR-0027).
  const deriver = new StatsDeriver({
    ledger,
    sessions,
    participants,
    stats,
    onError: (area, error, detail) => observer.error(area, error, detail),
    onEvent: (name, detail) => observer.event(name, detail),
  });
  const visits = new VisitIngest({
    stats,
    // The participant row is the truth; `bearer` refreshes this set on every
    // authenticated request, exactly as the PostHog sink relies on.
    optedOut: (id) => analytics.optedOutOf(id),
    trustGeoHeaders: cfg.PEN_TRUST_GEO_HEADERS,
    enabled: cfg.PEN_VISIT_STATS,
    identifierRetentionMs: cfg.PEN_VISIT_IDENTIFIER_DAYS * 86_400_000,
    onError: (area, error, detail) => observer.error(area, error, detail),
  });
  if (!cfg.PEN_VISIT_STATS) logger.info('visit statistics disabled (PEN_VISIT_STATS=0)');
  // Said at boot, because "how long do we keep an address" is a question
  // somebody will ask about the running deployment rather than about the
  // repository (ADR-0028). Never logs an address, here or anywhere.
  logger.info(
    { days: cfg.PEN_VISIT_IDENTIFIER_DAYS },
    cfg.PEN_VISIT_IDENTIFIER_DAYS > 0
      ? 'visit identifiers (address, raw User-Agent) are cleared after PEN_VISIT_IDENTIFIER_DAYS'
      : 'visit identifiers are not stored (PEN_VISIT_IDENTIFIER_DAYS=0), and existing ones are cleared',
  );
  await loadLanguageId();
  const intake = new TopicIntake(() => modelFor('free'), join(cfg.PEN_DATA_DIR, 'onten'));
  const downloadTokens = new DownloadTokens(cfg.PEN_JWT_SECRET);
  const renderer = new PlaywrightRenderer({
    baseUrl: cfg.PEN_RENDER_BASE_URL ?? cfg.PEN_PUBLIC_URL,
    // The page plays the recording as its host: the same token a download
    // link carries, minted for the host of the session being rendered.
    tokenFor: async (sessionId) => {
      const record = await sessions.get(sessionId);
      if (!record) throw new Error(`no session ${sessionId} to render`);
      return downloadTokens.issue(record.hostId, sessionId);
    },
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
    llmProvider,
    runtimeConfig,
    features,
    featureFlags,
    onten,
    memo,
    searchProvider,
    experts,
    voice,
    ttsCaches,
    recognizer,
    intentFor,
    graderFor,
    ledger,
    db,
    sessions,
    participants,
    authChallenges,
    mailer,
    lists,
    comments,
    stats,
    reports,
    deriver,
    visits,
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
