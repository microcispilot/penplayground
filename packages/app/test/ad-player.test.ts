import type { AdEndReason, AdEventName } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { type AdPlayer, type AdPlayerView, createAdPlayer } from '../src/ads/ad-player.js';
import type {
  ImaAd,
  ImaAdDisplayContainer,
  ImaAdErrorEvent,
  ImaAdEvent,
  ImaAdsLoader,
  ImaAdsManager,
  ImaAdsManagerLoadedEvent,
  ImaAdsRenderingSettings,
  ImaAdsRequest,
  ImaNamespace,
} from '../src/ads/ima.js';
import { limitedAdsHere } from '../src/lib/privacy.js';

// ── a fake clock ─────────────────────────────────────────────────────────────
class Clock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; every: number | null; id: number }> = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, every: null, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  setInterval = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, every: ms, id });
    return id;
  };
  clearInterval = this.clearTimeout;
  /** Advance and fire due timers in order. */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every) due.at += due.every;
      else this.timers = this.timers.filter((x) => x.id !== due.id);
      due.fn();
    }
    this.t = target;
  }
}

// ── a fake google.ima ────────────────────────────────────────────────────────
const TYPES = {
  LOADED: 'loaded',
  STARTED: 'start',
  AD_PROGRESS: 'adProgress',
  FIRST_QUARTILE: 'firstQuartile',
  MIDPOINT: 'midpoint',
  THIRD_QUARTILE: 'thirdQuartile',
  COMPLETE: 'complete',
  ALL_ADS_COMPLETED: 'allAdsCompleted',
  SKIPPED: 'skip',
  CLICK: 'click',
  VOLUME_MUTED: 'mute',
  VOLUME_CHANGED: 'volumeChange',
  CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
  CONTENT_RESUME_REQUESTED: 'contentResumeRequested',
  SKIPPABLE_STATE_CHANGED: 'skippableStateChanged',
} as const;

function fakeAd(opts: { skippable?: boolean; duration?: number } = {}): ImaAd {
  return {
    isSkippable: () => opts.skippable ?? false,
    getSkipTimeOffset: () => (opts.skippable ? 5 : -1),
    getDuration: () => opts.duration ?? 15,
    getTitle: () => 'Sample creative',
    getAdId: () => 'creative-1',
    isLinear: () => true,
    getAdPodInfo: () => ({ getTotalAds: () => 1, getAdPosition: () => 1 }),
  };
}

class FakeManager implements ImaAdsManager {
  listeners = new Map<string, Array<(e: ImaAdEvent) => void>>();
  calls: string[] = [];
  volume = 1;
  remaining = -1;
  /**
   * A creative that is really playing: its remaining time falls with the clock,
   * which is how the player tells a running ad from a frozen one. Left null for
   * a creative that started and then did nothing (headless Chromium has no
   * H.264, so this is the ordinary case there).
   */
  live: { at: number; durationS: number; now: () => number } | null = null;
  ad: ImaAd | null = null;
  init(w: number, h: number, mode: string) {
    this.calls.push(`init:${w}x${h}:${mode}`);
  }
  start() {
    this.calls.push('start');
  }
  stop() {
    this.calls.push('stop');
  }
  destroy() {
    this.calls.push('destroy');
  }
  resize(w: number, h: number) {
    this.calls.push(`resize:${w}x${h}`);
  }
  skip() {
    this.calls.push('skip');
    this.fire(TYPES.SKIPPED);
  }
  setVolume(v: number) {
    this.volume = v;
    this.calls.push(`volume:${v}`);
  }
  getVolume() {
    return this.volume;
  }
  getRemainingTime() {
    const live = this.live;
    if (!live) return this.remaining;
    return Math.max(0, live.durationS - (live.now() - live.at) / 1000);
  }
  getCurrentAd() {
    return this.ad;
  }
  addEventListener(type: string, listener: (event: ImaAdEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, ad: ImaAd | null = this.ad) {
    for (const l of this.listeners.get(type) ?? []) l({ type, getAd: () => ad });
  }
  error(code: number) {
    const ev: ImaAdErrorEvent = {
      getError: () => ({ getErrorCode: () => code, getMessage: () => `error ${code}` }),
    };
    for (const l of this.listeners.get('adError') ?? []) l(ev as unknown as ImaAdEvent);
  }
}

class FakeLoader implements ImaAdsLoader {
  listeners = new Map<string, Array<(e: never) => void>>();
  requests: ImaAdsRequest[] = [];
  destroyed = 0;
  constructor(private readonly sdk: FakeIma) {}
  requestAds(request: ImaAdsRequest) {
    this.requests.push(request);
    this.sdk.onRequest?.(this);
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  contentComplete() {}
  destroy() {
    this.destroyed += 1;
  }
  /** The ad server answered: hand a manager to the player. */
  deliver(manager: FakeManager) {
    const ev: ImaAdsManagerLoadedEvent = { getAdsManager: () => manager };
    for (const l of this.listeners.get('adsManagerLoaded') ?? []) l(ev as never);
  }
  error(code: number) {
    const ev: ImaAdErrorEvent = {
      getError: () => ({ getErrorCode: () => code, getMessage: () => `error ${code}` }),
    };
    for (const l of this.listeners.get('adError') ?? []) l(ev as never);
  }
}

class FakeIma implements ImaNamespace {
  loaders: FakeLoader[] = [];
  containers = 0;
  containersDestroyed = 0;
  onRequest: ((loader: FakeLoader) => void) | null = null;
  AdDisplayContainer = (() => {
    const self = this;
    return class implements ImaAdDisplayContainer {
      initialized = 0;
      constructor() {
        self.containers += 1;
      }
      initialize() {
        this.initialized += 1;
      }
      destroy() {
        self.containersDestroyed += 1;
      }
    };
  })();
  AdsLoader = (() => {
    const self = this;
    return class extends FakeLoader {
      constructor(_container: ImaAdDisplayContainer) {
        super(self);
        self.loaders.push(this);
      }
    };
  })();
  AdsRequest = class implements ImaAdsRequest {
    adTagUrl = '';
    linearAdSlotWidth = 0;
    linearAdSlotHeight = 0;
    nonLinearAdSlotWidth = 0;
    nonLinearAdSlotHeight = 0;
    willAutoPlay: boolean | null = null;
    willPlayMuted: boolean | null = null;
    setAdWillAutoPlay(v: boolean) {
      this.willAutoPlay = v;
    }
    setAdWillPlayMuted(v: boolean) {
      this.willPlayMuted = v;
    }
  };
  AdsRenderingSettings = class implements ImaAdsRenderingSettings {
    restoreCustomPlaybackStateOnAdBreakComplete = true;
    loadVideoTimeout = 8000;
    enablePreloading = false;
  };
  AdsManagerLoadedEvent = { Type: { ADS_MANAGER_LOADED: 'adsManagerLoaded' } };
  AdErrorEvent = { Type: { AD_ERROR: 'adError' } };
  AdEvent = { Type: TYPES };
  ViewMode = { NORMAL: 'normal', FULLSCREEN: 'fullscreen' };
  AdError = { ErrorCode: { AUTOPLAY_DISALLOWED: 1205 } };
  settings = { setLocale: () => undefined, setNumRedirects: () => undefined };
}

/** The slot and the content video, as much of an EventTarget as the player uses. */
class FakeSlot {
  readonly captured: Array<() => void> = [];
  readonly bubbled: Array<() => void> = [];
  addEventListener(_type: string, listener: () => void, capture?: boolean) {
    (capture ? this.captured : this.bubbled).push(listener);
  }
  removeEventListener(_type: string, listener: () => void, capture?: boolean) {
    const list = capture ? this.captured : this.bubbled;
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  }
  /** A media element inside the slot reported its clock moving. */
  timeupdate() {
    for (const l of [...this.captured, ...this.bubbled]) l();
  }
  get listening(): number {
    return this.captured.length + this.bubbled.length;
  }
}

// ── harness ──────────────────────────────────────────────────────────────────
interface Harness {
  player: AdPlayer;
  clock: Clock;
  ima: FakeIma;
  events: Array<{ name: AdEventName; props: Record<string, string | number | boolean> }>;
  views: AdPlayerView[];
  ended: AdEndReason[];
  names(): string[];
  container: FakeSlot;
  video: FakeSlot;
}

function harness(
  opts: {
    sdk?: 'ok' | 'reject' | 'hang';
    sound?: boolean;
    requestTimeoutMs?: number;
    progressTimeoutMs?: number;
  } = {},
): Harness {
  const clock = new Clock();
  const ima = new FakeIma();
  const events: Harness['events'] = [];
  const views: AdPlayerView[] = [];
  const ended: AdEndReason[] = [];
  const container = new FakeSlot();
  const video = new FakeSlot();
  const loadSdk = () =>
    opts.sdk === 'reject'
      ? Promise.reject(Object.assign(new Error('blocked'), { code: 'PEN_AD_SDK_BLOCKED' }))
      : opts.sdk === 'hang'
        ? new Promise<ImaNamespace>(() => undefined)
        : Promise.resolve<ImaNamespace>(ima);
  const player = createAdPlayer({
    ad: {
      adId: 'ad-s-1',
      tagUrl: 'https://ads.example.test/vast',
      slot: 'boundary',
      skippableAfterMs: 5000,
      durationMs: 30_000,
    },
    container: container as unknown as HTMLElement,
    video: video as unknown as HTMLVideoElement,
    loadSdk,
    size: () => ({ width: 640, height: 360 }),
    canAutoplayWithSound: () => opts.sound ?? true,
    onView: (v) => views.push(v),
    onEvent: (name, props) => events.push({ name, props }),
    onEnd: (reason) => ended.push(reason),
    rules: {
      sdkLoadTimeoutMs: 2000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 8000,
      progressTimeoutMs: opts.progressTimeoutMs ?? 4000,
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  return {
    player,
    clock,
    ima,
    events,
    views,
    ended,
    container,
    video,
    names: () => events.map((e) => e.name),
  };
}

/** Let the SDK promise settle (a microtask). */
const flush = () => new Promise<void>((r) => queueMicrotask(r));

async function playing(opts: Parameters<typeof harness>[0] & { stalls?: boolean } = {}) {
  const h = harness(opts);
  await flush();
  const loader = h.ima.loaders[0];
  if (!loader) throw new Error('no request made');
  const manager = new FakeManager();
  manager.ad = fakeAd({ skippable: false, duration: 15 });
  // The default creative plays; `stalls` is the one that starts and then freezes.
  if (!opts.stalls) manager.live = { at: h.clock.now(), durationS: 15, now: h.clock.now };
  loader.deliver(manager);
  manager.fire(TYPES.LOADED);
  manager.fire(TYPES.STARTED);
  return { ...h, loader, manager };
}

describe('ad player: happy path', () => {
  it('loads the SDK, requests the tag with autoplay hints, starts, and reports each step', async () => {
    const h = await playing();
    expect(h.names()).toEqual(['ad_requested', 'ad_loaded', 'ad_started']);
    const req = h.loader.requests[0] as InstanceType<FakeIma['AdsRequest']>;
    // Every request is non-personalised (ADR-0018), and limited where European
    // rules may reach the viewer — which is why there is no consent banner.
    const tag = new URL(req.adTagUrl);
    expect(tag.origin + tag.pathname).toBe('https://ads.example.test/vast');
    expect(tag.searchParams.get('npa')).toBe('1');
    expect(tag.searchParams.get('ltd')).toBe(limitedAdsHere() ? '1' : null);
    expect(req.linearAdSlotWidth).toBe(640);
    expect(req.willAutoPlay).toBe(true);
    expect(req.willPlayMuted).toBe(false);
    expect(h.manager.calls).toEqual(['init:640x360:normal', 'volume:1', 'start']);
    expect(h.player.view).toMatchObject({
      status: 'playing',
      skippable: false,
      muted: false,
      title: 'Sample creative',
      durationMs: 15_000,
      position: 1,
      total: 1,
    });
    expect(h.events[2]?.props).toMatchObject({ adId: 'ad-s-1', slot: 'boundary', muted: false });
  });

  it('becomes skippable at 5 s by our rule even when the creative is not skippable, then skips', async () => {
    const h = await playing();
    h.clock.advance(4999);
    expect(h.player.view.skippable).toBe(false);
    expect(h.player.view.skipInMs).toBe(1);
    h.player.skip(); // too early: ignored
    expect(h.ended).toEqual([]);
    h.clock.advance(1);
    expect(h.player.view.skippable).toBe(true);
    h.player.skip();
    expect(h.names().at(-1)).toBe('ad_skipped');
    expect(h.events.at(-1)?.props.atMs).toBe(5000);
    // A non-skippable creative is stopped, not "skipped", at the network.
    expect(h.manager.calls.slice(-2)).toEqual(['stop', 'destroy']);
    expect(h.ended).toEqual(['skipped']);
    expect(h.player.view.status).toBe('ended');
    h.player.skip(); // idempotent
    expect(h.ended).toEqual(['skipped']);
  });

  it('uses the creative skip when VAST allows it and reports the skip exactly once', async () => {
    const h = await playing();
    h.manager.ad = fakeAd({ skippable: true });
    h.manager.fire(TYPES.SKIPPABLE_STATE_CHANGED);
    expect(h.player.view.skippable).toBe(true); // creative offset came before our 5 s
    h.clock.advance(3000);
    h.player.skip();
    expect(h.manager.calls).toContain('skip');
    expect(h.names().filter((n) => n === 'ad_skipped')).toHaveLength(1);
    expect(h.ended).toEqual(['skipped']);
  });

  it('quartiles, completion and click flow through; ALL_ADS_COMPLETED resumes once', async () => {
    const h = await playing();
    h.manager.fire(TYPES.FIRST_QUARTILE);
    h.manager.fire(TYPES.MIDPOINT);
    h.manager.fire(TYPES.CLICK);
    h.manager.fire(TYPES.THIRD_QUARTILE);
    h.manager.fire(TYPES.COMPLETE);
    h.manager.fire(TYPES.CONTENT_RESUME_REQUESTED);
    h.manager.fire(TYPES.ALL_ADS_COMPLETED);
    expect(h.names()).toEqual([
      'ad_requested',
      'ad_loaded',
      'ad_started',
      'ad_first_quartile',
      'ad_midpoint',
      'ad_clicked',
      'ad_third_quartile',
      'ad_completed',
    ]);
    expect(h.ended).toEqual(['completed']);
    expect(h.manager.calls.at(-1)).toBe('destroy');
  });

  it('publishes remaining time from the SDK while playing', async () => {
    const h = await playing({ stalls: true });
    h.manager.remaining = 9.4;
    h.clock.advance(250);
    expect(h.views.at(-1)?.remainingMs).toBe(9400);
    expect(h.views.at(-1)?.elapsedMs).toBe(250);
  });
});

describe('ad player: a creative that starts and then goes nowhere', () => {
  it('ends the ad and resumes the lesson, reporting why', async () => {
    const h = await playing({ stalls: true, progressTimeoutMs: 4000 });
    expect(h.names()).toEqual(['ad_requested', 'ad_loaded', 'ad_started']);

    // Just under the deadline the overlay is still the creative's to use.
    h.clock.advance(3999);
    expect(h.ended).toEqual([]);
    expect(h.player.view.status).toBe('playing');

    // Past it: one `ad_error` with the reason, through the same telemetry every
    // other ad outcome uses, and the lesson gets its turn back.
    h.clock.advance(1);
    expect(h.names()).toEqual(['ad_requested', 'ad_loaded', 'ad_started', 'ad_error']);
    expect(h.events.at(-1)?.props).toMatchObject({ code: 'STALLED', adId: 'ad-s-1' });
    expect(h.ended).toEqual(['error']);
    expect(h.player.view.status).toBe('ended');
    // And the SDK is torn down with it, so nothing can start playing afterwards.
    expect(h.manager.calls).toContain('destroy');
  });

  it('the SDK saying the ad is progressing keeps it alive', async () => {
    const h = await playing({ stalls: true, progressTimeoutMs: 4000 });
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(3000);
      h.manager.fire(TYPES.AD_PROGRESS);
    }
    expect(h.ended).toEqual([]);
    expect(h.player.view.status).toBe('playing');
  });

  it('a media element inside the slot ticking keeps it alive', async () => {
    const h = await playing({ stalls: true, progressTimeoutMs: 4000 });
    expect(h.container.listening).toBe(1);
    expect(h.video.listening).toBe(1);
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(3000);
      h.container.timeupdate();
    }
    expect(h.ended).toEqual([]);
    // The listeners come off with the ad, so a later tick cannot touch a dead player.
    h.clock.advance(5000);
    expect(h.ended).toEqual(['error']);
    expect(h.container.listening).toBe(0);
    expect(h.video.listening).toBe(0);
  });

  it('a creative whose own clock is running is never cut short', async () => {
    const h = await playing({ progressTimeoutMs: 4000 });
    // No AD_PROGRESS at all, only the remaining time falling: that is enough.
    h.clock.advance(12_000);
    expect(h.ended).toEqual([]);
    expect(h.player.view.status).toBe('playing');
  });

  it('quartiles count as progress on their own', async () => {
    const h = await playing({ stalls: true, progressTimeoutMs: 4000 });
    h.clock.advance(3500);
    h.manager.fire(TYPES.FIRST_QUARTILE);
    h.clock.advance(3500);
    h.manager.fire(TYPES.MIDPOINT);
    h.clock.advance(3500);
    h.manager.fire(TYPES.THIRD_QUARTILE);
    h.clock.advance(3500);
    expect(h.ended).toEqual([]);
    expect(h.names()).toEqual([
      'ad_requested',
      'ad_loaded',
      'ad_started',
      'ad_first_quartile',
      'ad_midpoint',
      'ad_third_quartile',
    ]);
  });

  it('a learner who skips a frozen creative is not also told it failed', async () => {
    const h = await playing({ stalls: true, progressTimeoutMs: 4000 });
    h.clock.advance(3000);
    // The 5 s skip rule has not come round yet, so make it skippable the way VAST would.
    h.manager.ad = fakeAd({ skippable: true, duration: 15 });
    h.manager.fire(TYPES.SKIPPABLE_STATE_CHANGED, h.manager.ad);
    h.player.skip();
    expect(h.ended).toEqual(['skipped']);
    h.clock.advance(10_000);
    expect(h.ended).toEqual(['skipped']);
    expect(h.names()).not.toContain('ad_error');
  });
});

describe('ad player: failure paths (never dead air)', () => {
  it('resumes within 2 s when the SDK never arrives (ad blocker)', () => {
    const h = harness({ sdk: 'hang' });
    h.clock.advance(1999);
    expect(h.ended).toEqual([]);
    h.clock.advance(1);
    expect(h.names()).toEqual(['ad_error']);
    expect(h.events[0]?.props.code).toBe('SDK_TIMEOUT');
    expect(h.ended).toEqual(['blocked']);
  });

  it('resumes immediately when the SDK script fails to load', async () => {
    const h = harness({ sdk: 'reject' });
    await flush();
    expect(h.events[0]?.props.code).toBe('PEN_AD_SDK_BLOCKED');
    expect(h.ended).toEqual(['blocked']);
    expect(h.ima.loaders).toHaveLength(0);
  });

  it('resumes when the tag never answers (request timeout)', async () => {
    const h = harness({ requestTimeoutMs: 8000 });
    await flush();
    expect(h.names()).toEqual(['ad_requested']);
    h.clock.advance(8000);
    expect(h.names()).toEqual(['ad_requested', 'ad_error']);
    expect(h.events[1]?.props.code).toBe('TIMEOUT');
    expect(h.ended).toEqual(['timeout']);
  });

  it('resumes on an ad error from the loader (e.g. VAST empty response 1009)', async () => {
    const h = harness();
    await flush();
    h.ima.loaders[0]?.error(1009);
    expect(h.events.at(-1)).toEqual({
      name: 'ad_error',
      props: { adId: 'ad-s-1', slot: 'boundary', atMs: 0, code: '1009' },
    });
    expect(h.ended).toEqual(['error']);
  });

  it('the skip rule still applies while the ad is loading: the learner is never stuck', async () => {
    const h = harness({ requestTimeoutMs: 20_000 });
    await flush();
    h.clock.advance(5000);
    expect(h.player.view.skippable).toBe(true);
    h.player.skip();
    expect(h.ended).toEqual(['skipped']);
  });

  it('destroy() while active reports the ceiling and tears IMA down without resuming twice', async () => {
    const h = await playing();
    h.player.destroy();
    expect(h.names().at(-1)).toBe('ad_error');
    expect(h.events.at(-1)?.props.code).toBe('CEILING');
    expect(h.manager.calls.at(-1)).toBe('destroy');
    expect(h.ended).toEqual([]);
    h.player.skip();
    expect(h.ended).toEqual([]);
  });
});

describe('ad player: teardown before anything happened (React StrictMode double mount)', () => {
  it('is silent: no events, no resume', () => {
    const h = harness({ sdk: 'hang' });
    h.player.destroy();
    h.clock.advance(5000);
    expect(h.events).toEqual([]);
    expect(h.ended).toEqual([]);
  });
});

describe('ad player: autoplay and sound', () => {
  it('requests muted when the page has had no gesture, and unmute() raises the volume', async () => {
    const h = await playing({ sound: false });
    const req = h.loader.requests[0] as InstanceType<FakeIma['AdsRequest']>;
    expect(req.willPlayMuted).toBe(true);
    expect(h.manager.calls).toContain('volume:0');
    expect(h.player.view.muted).toBe(true);
    expect(h.events[2]?.props.muted).toBe(true);
    h.player.unmute();
    expect(h.manager.calls.at(-1)).toBe('volume:1');
    expect(h.player.view.muted).toBe(false);
  });

  it('retries once muted when the browser refuses autoplay with sound (IMA 1205)', async () => {
    const h = harness({ sound: true });
    await flush();
    const first = h.ima.loaders[0];
    if (!first) throw new Error('no request');
    const m1 = new FakeManager();
    first.deliver(m1);
    m1.error(1205);
    // A second request went out, muted; the ad has not ended.
    expect(h.ima.loaders).toHaveLength(2);
    const req2 = h.ima.loaders[1]?.requests[0] as InstanceType<FakeIma['AdsRequest']>;
    expect(req2.willPlayMuted).toBe(true);
    expect(h.ended).toEqual([]);
    expect(h.names()).toEqual(['ad_requested', 'ad_requested']);
    const m2 = new FakeManager();
    m2.ad = fakeAd();
    h.ima.loaders[1]?.deliver(m2);
    m2.fire(TYPES.STARTED);
    expect(h.player.view).toMatchObject({ status: 'playing', muted: true });
    // A second 1205 is a real error.
    m2.error(1205);
    expect(h.ended).toEqual(['error']);
  });

  it('follows the SDK volume events into the view', async () => {
    const h = await playing();
    h.manager.fire(TYPES.VOLUME_MUTED);
    expect(h.player.view.muted).toBe(true);
    h.manager.volume = 0.7;
    h.manager.fire(TYPES.VOLUME_CHANGED);
    expect(h.player.view.muted).toBe(false);
  });
});
