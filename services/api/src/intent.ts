import { type CostMeter, JevDecisionsModel } from '@pen/llm';
import { INTENT_TIMEOUT_MS, type IntentClassifier, JevIntentClassifier } from '@pen/session-engine';
import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * The hosted intent classifier per deployment, the way `createRecognizer`
 * chooses an STT provider. `model` — the default — returns null, and a turn
 * the local heuristics cannot place goes to the session's own model exactly
 * as it always has; the room owns that path and always has it, so a null here
 * is a configuration, never a missing dependency.
 */
export function createIntentClassifier(cfg: Config, meter?: CostMeter): IntentClassifier | null {
  switch (cfg.PEN_INTENT_PROVIDER) {
    case 'model':
      return null;
    case 'jev': {
      if (!cfg.OPENROUTER_API_KEY)
        throw new Error('PEN_INTENT_PROVIDER=jev requires OPENROUTER_API_KEY');
      logger.info(
        { evt: 'intent.provider', model: cfg.PEN_INTENT_MODEL, timeoutMs: INTENT_TIMEOUT_MS },
        'intent classified by a hosted decisions model; the session model stays as the fallback',
      );
      return new JevIntentClassifier({
        decisions: new JevDecisionsModel({
          apiKey: cfg.OPENROUTER_API_KEY,
          model: cfg.PEN_INTENT_MODEL,
          timeoutMs: INTENT_TIMEOUT_MS,
          ...(meter ? { meter } : {}),
        }),
      });
    }
  }
}
