import { AD_RULES, GOOGLE_IMA_SAMPLE_TAG, hasEntitlement, type PlanCode } from '@pen/contracts';
import type { AdOutcome, AdPolicy } from '@pen/session-engine';
import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * Where the free plan's video ads come from (ADR-0014). One VAST/VMAP tag URL
 * is the whole network abstraction: Google Ad Manager today; another seller's
 * tag drops in through `PEN_AD_TAG_URL` with no client change.
 */
export type AdDemand =
  | { source: 'configured'; tagUrl: string }
  | { source: 'google-sample'; tagUrl: string }
  | { source: 'off'; tagUrl: null; reason: string };

export function resolveAdDemand(cfg: Config): AdDemand {
  if (cfg.PEN_AD_TAG_URL) return { source: 'configured', tagUrl: cfg.PEN_AD_TAG_URL };
  if (cfg.PEN_AD_TEST_TAGS) return { source: 'google-sample', tagUrl: GOOGLE_IMA_SAMPLE_TAG };
  return {
    source: 'off',
    tagUrl: null,
    reason:
      'free plan shows no ads: set PEN_AD_TAG_URL (Google Ad Manager VAST tag, docs/ADS.md) or PEN_AD_TEST_TAGS=1 for the sample tag in development',
  };
}

export interface SessionAdTally {
  requested: number;
  started: number;
  completed: number;
  skipped: number;
  errors: number;
  clicks: number;
  /** Estimated, from PEN_AD_ECPM_USD × completed; Ad Manager reporting is the source of truth. */
  revenueUsd: number;
}

const EMPTY: SessionAdTally = {
  requested: 0,
  started: 0,
  completed: 0,
  skipped: 0,
  errors: 0,
  clicks: 0,
  revenueUsd: 0,
};

/** Something that can carry a negative cost line: the API's CostLedger. */
export interface RevenueSink {
  credit(purpose: string, usd: number): void;
}

/**
 * Turns host-reported ad outcomes into per-session economics. Revenue is an
 * estimate (eCPM × completed) so a session's cost lines can show ads offsetting
 * them before Ad Manager reporting exists; the estimate is labelled as such
 * everywhere it appears.
 */
export class AdEconomics {
  readonly demand: AdDemand;
  private readonly ecpmUsd: number;
  private readonly bySession = new Map<string, SessionAdTally>();

  constructor(
    cfg: Config,
    private readonly revenue: RevenueSink | null = null,
  ) {
    this.demand = resolveAdDemand(cfg);
    this.ecpmUsd = cfg.PEN_AD_ECPM_USD;
    if (this.demand.source === 'off') logger.info({ evt: 'ads.off' }, this.demand.reason);
    else logger.info({ evt: 'ads.on', source: this.demand.source, ecpmUsd: this.ecpmUsd });
  }

  /** The room's ad policy for an ad-supported host; null when the plan pays or there is no demand. */
  policyFor(plan: PlanCode, everySegments: number): AdPolicy | null {
    if (hasEntitlement(plan, 'no_ads') || !this.demand.tagUrl) return null;
    return {
      everySegments,
      durationMs: AD_RULES.maxDurationMs,
      skippableAfterMs: AD_RULES.skipAfterMs,
      tagUrl: this.demand.tagUrl,
      onEvent: (o) => this.record(o),
    };
  }

  record(o: AdOutcome): void {
    const t = { ...(this.bySession.get(o.sessionId) ?? EMPTY) };
    switch (o.event) {
      case 'ad_requested':
        t.requested += 1;
        break;
      case 'ad_started':
        t.started += 1;
        break;
      case 'ad_completed': {
        t.completed += 1;
        const usd = this.ecpmUsd / 1000;
        t.revenueUsd += usd;
        // Revenue is a negative cost line so the ledger's per-purpose totals net out by themselves.
        this.revenue?.credit('ads', usd);
        break;
      }
      case 'ad_skipped':
        t.skipped += 1;
        break;
      case 'ad_error':
        t.errors += 1;
        break;
      case 'ad_clicked':
        t.clicks += 1;
        break;
      default:
        break;
    }
    this.bySession.set(o.sessionId, t);
  }

  tally(sessionId: string): SessionAdTally {
    return this.bySession.get(sessionId) ?? EMPTY;
  }

  /** Called when a session is released; the totals already went to the cost ledger and analytics. */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
