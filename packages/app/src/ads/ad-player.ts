import type { AdEndReason, AdEventName, AdSlot } from '@pen/contracts';
import { AD_RULES, nonPersonalisedTag } from '@pen/contracts';
import { limitedAdsHere } from '../lib/privacy.js';
import {
  IMA_ERROR,
  type ImaAd,
  type ImaAdDisplayContainer,
  type ImaAdErrorEvent,
  type ImaAdEvent,
  type ImaAdsLoader,
  type ImaAdsManager,
  type ImaAdsManagerLoadedEvent,
  type ImaNamespace,
} from './ima.js';

/**
 * The video ad player, headless (ADR-0014). Owns the IMA objects and the
 * product rules around them — skippable after 5 s no matter what the creative
 * says, resume the lesson within 2 s when the SDK is blocked, never dead air —
 * and exposes a view model the React overlay renders. Every outcome ends in
 * exactly one `onEnd(reason)`, which the room turns into `skipAd()`.
 */

export type AdPlayerStatus = 'loading' | 'requesting' | 'playing' | 'ended';

export interface AdPlayerView {
  status: AdPlayerStatus;
  /** Our own rule (5 s from the start of the overlay) OR the creative's skip offset: whichever first. */
  skippable: boolean;
  /** ms until our own skip rule allows it; 0 once skippable. */
  skipInMs: number;
  muted: boolean;
  /** ms since the overlay appeared. */
  elapsedMs: number;
  /** Time left in the creative when known (IMA), otherwise until the ceiling. */
  remainingMs: number;
  /** Creative duration from VAST when known. */
  durationMs: number | null;
  title: string | null;
  /** "Ad 1 of 1" – pod position from VAST; 1/1 until known. */
  position: number;
  total: number;
  endedWith: AdEndReason | null;
}

export interface AdPlayerAd {
  adId: string;
  tagUrl: string;
  slot: AdSlot;
  skippableAfterMs: number;
  durationMs: number;
}

export interface AdPlayerOptions {
  ad: AdPlayerAd;
  /** The overlay element the SDK renders into (must sit over `video`, top-left aligned). */
  container: HTMLElement;
  /** Content video element the SDK needs on mobile; stays hidden and silent for us. */
  video: HTMLVideoElement;
  loadSdk: () => Promise<ImaNamespace>;
  /** Current size of the ad frame. */
  size: () => { width: number; height: number };
  /** Whether the page has had a user gesture (autoplay with sound is then allowed). */
  canAutoplayWithSound: () => boolean;
  locale?: string;
  onView: (view: AdPlayerView) => void;
  onEvent: (name: AdEventName, props: Record<string, string | number | boolean>) => void;
  onEnd: (reason: AdEndReason) => void;
  rules?: { sdkLoadTimeoutMs?: number; requestTimeoutMs?: number };
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface AdPlayer {
  skip(): void;
  unmute(): void;
  resize(): void;
  destroy(): void;
  readonly view: AdPlayerView;
}

export function createAdPlayer(o: AdPlayerOptions): AdPlayer {
  const now = o.now ?? (() => Date.now());
  const setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const setI = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = o.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const sdkTimeoutMs = o.rules?.sdkLoadTimeoutMs ?? AD_RULES.sdkLoadTimeoutMs;
  const requestTimeoutMs = o.rules?.requestTimeoutMs ?? AD_RULES.requestTimeoutMs;
  const startedAt = now();

  const view: AdPlayerView = {
    status: 'loading',
    skippable: false,
    skipInMs: o.ad.skippableAfterMs,
    muted: !o.canAutoplayWithSound(),
    elapsedMs: 0,
    remainingMs: o.ad.durationMs,
    durationMs: null,
    title: null,
    position: 1,
    total: 1,
    endedWith: null,
  };

  let ima: ImaNamespace | null = null;
  let displayContainer: ImaAdDisplayContainer | null = null;
  let loader: ImaAdsLoader | null = null;
  let manager: ImaAdsManager | null = null;
  let currentAd: ImaAd | null = null;
  let requestTimer: unknown = null;
  let tick: unknown = null;
  let destroyed = false;
  let retriedMuted = false;
  let skipReported = false;

  const elapsed = () => now() - startedAt;
  /** Time-derived fields are computed on read so the view is never a stale snapshot. */
  const refreshTimes = () => {
    view.elapsedMs = elapsed();
    view.skipInMs = Math.max(0, o.ad.skippableAfterMs - view.elapsedMs);
    if (view.status === 'playing' && manager) {
      const left = manager.getRemainingTime();
      view.remainingMs =
        left >= 0 ? Math.round(left * 1000) : Math.max(0, o.ad.durationMs - view.elapsedMs);
    } else view.remainingMs = Math.max(0, o.ad.durationMs - view.elapsedMs);
  };
  const publish = () => {
    if (destroyed) return;
    refreshTimes();
    o.onView({ ...view });
  };
  const event = (name: AdEventName, props: Record<string, string | number | boolean> = {}) => {
    if (destroyed) return;
    o.onEvent(name, { adId: o.ad.adId, slot: o.ad.slot, atMs: elapsed(), ...props });
  };

  const skipTimer = setT(() => {
    view.skippable = true;
    publish();
  }, o.ad.skippableAfterMs);

  const teardownIma = () => {
    try {
      manager?.destroy();
    } catch {
      /* the SDK may already have torn itself down */
    }
    try {
      loader?.destroy();
    } catch {
      /* ditto */
    }
    try {
      displayContainer?.destroy();
    } catch {
      /* ditto */
    }
    manager = null;
    loader = null;
    displayContainer = null;
    currentAd = null;
  };

  const end = (reason: AdEndReason) => {
    if (view.status === 'ended' || destroyed) return;
    view.status = 'ended';
    view.endedWith = reason;
    if (requestTimer) clearT(requestTimer);
    if (tick) clearI(tick);
    clearT(skipTimer);
    publish();
    teardownIma();
    o.onEnd(reason);
  };

  const fail = (code: string, reason: AdEndReason = 'error') => {
    event('ad_error', { code });
    end(reason);
  };

  const onAdError = (e: ImaAdErrorEvent) => {
    if (view.status === 'ended') return;
    const err = e.getError();
    const code = err.getErrorCode();
    // Autoplay with sound refused after all: one retry muted, with tap-to-unmute in the overlay.
    if (code === IMA_ERROR.AUTOPLAY_DISALLOWED && !retriedMuted && ima) {
      retriedMuted = true;
      view.muted = true;
      teardownIma();
      request(ima);
      return;
    }
    fail(String(code));
  };

  const onAdEvent = (e: ImaAdEvent) => {
    if (view.status === 'ended' || !ima) return;
    const T = ima.AdEvent.Type;
    const ad = e.getAd();
    if (ad) currentAd = ad;
    switch (e.type) {
      case T.LOADED: {
        if (ad) {
          view.title = ad.getTitle() || null;
          const d = ad.getDuration();
          view.durationMs = d > 0 ? Math.round(d * 1000) : null;
          const pod = ad.getAdPodInfo();
          view.position = Math.max(1, pod.getAdPosition());
          view.total = Math.max(1, pod.getTotalAds());
        }
        event('ad_loaded', {
          durationMs: view.durationMs ?? -1,
          vastSkippable: ad?.isSkippable() ?? false,
        });
        publish();
        return;
      }
      case T.STARTED:
        if (requestTimer) clearT(requestTimer);
        requestTimer = null;
        view.status = 'playing';
        event('ad_started', { muted: view.muted });
        if (!tick) tick = setI(publish, 250);
        publish();
        return;
      case T.SKIPPABLE_STATE_CHANGED:
        // The creative's own offset (VAST) may come before ours; whichever first.
        if (currentAd?.isSkippable()) {
          view.skippable = true;
          publish();
        }
        return;
      case T.FIRST_QUARTILE:
        event('ad_first_quartile');
        return;
      case T.MIDPOINT:
        event('ad_midpoint');
        return;
      case T.THIRD_QUARTILE:
        event('ad_third_quartile');
        return;
      case T.COMPLETE:
        event('ad_completed');
        return;
      case T.ALL_ADS_COMPLETED:
      case T.CONTENT_RESUME_REQUESTED:
        end('completed');
        return;
      case T.SKIPPED:
        if (!skipReported) {
          skipReported = true;
          event('ad_skipped', { atMs: elapsed() });
        }
        end('skipped');
        return;
      case T.CLICK:
        event('ad_clicked');
        return;
      case T.VOLUME_MUTED:
        view.muted = true;
        publish();
        return;
      case T.VOLUME_CHANGED:
        view.muted = (manager?.getVolume() ?? 1) === 0;
        publish();
        return;
      default:
        return;
    }
  };

  const request = (sdk: ImaNamespace) => {
    try {
      displayContainer = new sdk.AdDisplayContainer(o.container, o.video);
      loader = new sdk.AdsLoader(displayContainer);
      loader.addEventListener(sdk.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (e) =>
        onManagerLoaded(sdk, e as ImaAdsManagerLoadedEvent),
      );
      loader.addEventListener(sdk.AdErrorEvent.Type.AD_ERROR, (e) =>
        onAdError(e as ImaAdErrorEvent),
      );
      const { width, height } = o.size();
      const req = new sdk.AdsRequest();
      // The server already asked for non-personalised ads; where European rules
      // may reach this viewer, ask for limited ads too — no identifiers read or
      // written, and so nothing to put a consent wall in front of (ADR-0017).
      req.adTagUrl = nonPersonalisedTag(o.ad.tagUrl, { limited: limitedAdsHere() });
      req.linearAdSlotWidth = width;
      req.linearAdSlotHeight = height;
      req.nonLinearAdSlotWidth = width;
      req.nonLinearAdSlotHeight = Math.round(height / 3);
      req.setAdWillAutoPlay(true);
      req.setAdWillPlayMuted(view.muted);
      view.status = 'requesting';
      event('ad_requested', { muted: view.muted });
      publish();
      if (requestTimer) clearT(requestTimer);
      requestTimer = setT(() => fail('TIMEOUT', 'timeout'), requestTimeoutMs);
      loader.requestAds(req);
    } catch (error) {
      fail(error instanceof Error ? `SDK:${error.name}` : 'SDK');
    }
  };

  const onManagerLoaded = (sdk: ImaNamespace, e: ImaAdsManagerLoadedEvent) => {
    if (view.status === 'ended') return;
    try {
      const settings = new sdk.AdsRenderingSettings();
      settings.restoreCustomPlaybackStateOnAdBreakComplete = false;
      settings.loadVideoTimeout = Math.max(1000, requestTimeoutMs - 1000);
      settings.enablePreloading = true;
      manager = e.getAdsManager(o.video, settings);
      for (const t of Object.values(sdk.AdEvent.Type)) manager.addEventListener(t, onAdEvent);
      manager.addEventListener(sdk.AdErrorEvent.Type.AD_ERROR, (ev) =>
        onAdError(ev as unknown as ImaAdErrorEvent),
      );
      displayContainer?.initialize();
      const { width, height } = o.size();
      manager.init(width, height, sdk.ViewMode.NORMAL);
      manager.setVolume(view.muted ? 0 : 1);
      manager.start();
    } catch (error) {
      fail(error instanceof Error ? `SDK:${error.name}` : 'SDK');
    }
  };

  // ── boot: SDK within the deadline, else the lesson resumes (ad blockers, offline) ──
  let sdkSettled = false;
  const sdkTimer = setT(() => {
    if (!sdkSettled) {
      sdkSettled = true;
      fail('SDK_TIMEOUT', 'blocked');
    }
  }, sdkTimeoutMs);
  o.loadSdk().then(
    (sdk) => {
      if (sdkSettled || destroyed) return;
      sdkSettled = true;
      clearT(sdkTimer);
      ima = sdk;
      if (o.locale) sdk.settings.setLocale(o.locale);
      request(sdk);
    },
    (error: unknown) => {
      if (sdkSettled || destroyed) return;
      sdkSettled = true;
      clearT(sdkTimer);
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : 'PEN_AD_SDK_BLOCKED';
      fail(code, 'blocked');
    },
  );
  publish();

  return {
    get view() {
      if (!destroyed) refreshTimes();
      return { ...view };
    },
    skip() {
      if (view.status === 'ended' || !view.skippable) return;
      skipReported = true;
      event('ad_skipped', { atMs: elapsed() });
      // The creative's skip when the VAST allows it (counts as a skip at the network); ours otherwise.
      try {
        if (manager && currentAd?.isSkippable()) manager.skip();
        else manager?.stop();
      } catch {
        /* the SDK is torn down below regardless */
      }
      end('skipped');
    },
    unmute() {
      view.muted = false;
      try {
        manager?.setVolume(1);
      } catch {
        /* nothing to unmute yet: the request already asked for sound */
      }
      publish();
    },
    resize() {
      if (!manager || !ima) return;
      const { width, height } = o.size();
      manager.resize(width, height, ima.ViewMode.NORMAL);
    },
    destroy() {
      if (destroyed) return;
      // Torn down while an ad was in flight: the conductor's ceiling ended it, not the creative.
      // (A teardown before the SDK even answered — React StrictMode's double mount — is silent.)
      if (view.status === 'requesting' || view.status === 'playing')
        event('ad_error', { code: 'CEILING' });
      destroyed = true;
      clearT(sdkTimer);
      clearT(skipTimer);
      if (requestTimer) clearT(requestTimer);
      if (tick) clearI(tick);
      teardownIma();
    },
  };
}

/** True once the page has had a user gesture, when the browser can tell us. */
export function hasUserActivation(nav: Navigator = navigator): boolean {
  const ua = (nav as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return ua ? ua.hasBeenActive : true;
}
