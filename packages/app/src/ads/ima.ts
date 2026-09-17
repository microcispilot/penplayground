/**
 * Google IMA HTML5 SDK: the typed surface we use, and a lazy loader.
 *
 * The SDK is never on the page until an ad is about to show (page weight,
 * privacy, and the free plan is the only one that ever needs it). Loading is
 * a single shared promise; a failure (ad blocker, offline) rejects quickly
 * and is forgotten so the next ad can try again.
 *
 * Reference: https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side
 */

export const IMA_SDK_URL = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';

export interface ImaAdPodInfo {
  getTotalAds(): number;
  getAdPosition(): number;
}
export interface ImaAd {
  isSkippable(): boolean;
  /** Seconds; -1 when the ad is not skippable. */
  getSkipTimeOffset(): number;
  /** Seconds; -1 when unknown. */
  getDuration(): number;
  getTitle(): string;
  getAdId(): string;
  isLinear(): boolean;
  getAdPodInfo(): ImaAdPodInfo;
}
export interface ImaAdEvent {
  type: string;
  getAd(): ImaAd | null;
}
export interface ImaAdError {
  getErrorCode(): number;
  getMessage(): string;
}
export interface ImaAdErrorEvent {
  getError(): ImaAdError;
}
export interface ImaAdsRenderingSettings {
  restoreCustomPlaybackStateOnAdBreakComplete: boolean;
  /** ms the SDK waits for the creative to start before AD_ERROR. */
  loadVideoTimeout: number;
  enablePreloading: boolean;
}
export interface ImaAdsRequest {
  adTagUrl: string;
  linearAdSlotWidth: number;
  linearAdSlotHeight: number;
  nonLinearAdSlotWidth: number;
  nonLinearAdSlotHeight: number;
  setAdWillAutoPlay(willAutoPlay: boolean): void;
  setAdWillPlayMuted(willPlayMuted: boolean): void;
}
export interface ImaAdsManager {
  init(width: number, height: number, viewMode: string): void;
  start(): void;
  stop(): void;
  destroy(): void;
  resize(width: number, height: number, viewMode: string): void;
  skip(): void;
  setVolume(volume: number): void;
  getVolume(): number;
  /** Seconds; -1 when unknown. */
  getRemainingTime(): number;
  getCurrentAd(): ImaAd | null;
  addEventListener(type: string, listener: (event: ImaAdEvent) => void): void;
}
export interface ImaAdsManagerLoadedEvent {
  getAdsManager(content: HTMLElement, settings: ImaAdsRenderingSettings): ImaAdsManager;
}
export interface ImaAdsLoader {
  requestAds(request: ImaAdsRequest): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  contentComplete(): void;
  destroy(): void;
}
export interface ImaAdDisplayContainer {
  /** Must run inside (or after) a user gesture on mobile; safe to call any time on desktop. */
  initialize(): void;
  destroy(): void;
}

export type ImaAdEventType =
  | 'LOADED'
  | 'STARTED'
  | 'FIRST_QUARTILE'
  | 'MIDPOINT'
  | 'THIRD_QUARTILE'
  | 'COMPLETE'
  | 'ALL_ADS_COMPLETED'
  | 'SKIPPED'
  | 'CLICK'
  | 'VOLUME_MUTED'
  | 'VOLUME_CHANGED'
  | 'CONTENT_PAUSE_REQUESTED'
  | 'CONTENT_RESUME_REQUESTED'
  | 'SKIPPABLE_STATE_CHANGED';

export interface ImaNamespace {
  AdDisplayContainer: new (
    container: HTMLElement,
    video?: HTMLVideoElement,
  ) => ImaAdDisplayContainer;
  AdsLoader: new (container: ImaAdDisplayContainer) => ImaAdsLoader;
  AdsRequest: new () => ImaAdsRequest;
  AdsRenderingSettings: new () => ImaAdsRenderingSettings;
  AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: string } };
  AdErrorEvent: { Type: { AD_ERROR: string } };
  AdEvent: { Type: Record<ImaAdEventType, string> };
  ViewMode: { NORMAL: string; FULLSCREEN: string };
  /** google.ima.AdError.ErrorCode.AUTOPLAY_DISALLOWED and friends. */
  AdError: { ErrorCode: Record<string, number> };
  settings: { setLocale(locale: string): void; setNumRedirects(n: number): void };
}

/** google.ima.AdError.ErrorCode values we branch on (stable across SDK releases). */
export const IMA_ERROR = {
  AUTOPLAY_DISALLOWED: 1205,
  VAST_EMPTY_RESPONSE: 1009,
} as const;

declare global {
  interface Window {
    google?: GoogleGlobal;
  }
  /** Merged with the sign-in half in lib/google.ts: one `window.google` for every Google SDK. */
  interface GoogleGlobal {
    ima?: ImaNamespace;
  }
}

export interface LoadImaOptions {
  timeoutMs: number;
  doc?: Document;
  win?: { google?: { ima?: ImaNamespace } };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class ImaLoadError extends Error {
  constructor(readonly code: 'PEN_AD_SDK_BLOCKED' | 'PEN_AD_SDK_TIMEOUT') {
    super(code);
    this.name = 'ImaLoadError';
  }
}

let pending: Promise<ImaNamespace> | null = null;

/**
 * Resolve the `google.ima` namespace, injecting the SDK script on first use.
 * Rejects with `ImaLoadError` when the script fails (typically an ad blocker)
 * or is not there within `timeoutMs`; the lesson resumes in either case.
 */
export function loadIma(options: LoadImaOptions): Promise<ImaNamespace> {
  const win = options.win ?? window;
  const doc = options.doc ?? document;
  const existing = win.google?.ima;
  if (existing) return Promise.resolve(existing);
  if (pending) return pending;
  const setT = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  pending = new Promise<ImaNamespace>((resolve, reject) => {
    let settled = false;
    const finish = (result: ImaNamespace | ImaLoadError) => {
      if (settled) return;
      settled = true;
      clearT(timer);
      if (result instanceof ImaLoadError) {
        pending = null; // let the next ad retry
        script.remove();
        reject(result);
      } else resolve(result);
    };
    const timer = setT(() => finish(new ImaLoadError('PEN_AD_SDK_TIMEOUT')), options.timeoutMs);
    const script = doc.createElement('script');
    script.src = IMA_SDK_URL;
    script.async = true;
    script.onload = () => {
      const ima = win.google?.ima;
      finish(ima ?? new ImaLoadError('PEN_AD_SDK_BLOCKED'));
    };
    script.onerror = () => finish(new ImaLoadError('PEN_AD_SDK_BLOCKED'));
    doc.head.appendChild(script);
  });
  return pending;
}

/** Test seam: forget a previous attempt. */
export function resetImaLoader(): void {
  pending = null;
}
