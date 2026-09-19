import { type CostMeter, JevDecisionsModel } from '@pen/llm';
import { INTENT_TIMEOUT_MS, type IntentClassifier, JevIntentClassifier } from '@pen/session-engine';
import type { Config } from './config.js';
import { logger } from './logger.js';
import type { RuntimeConfigStore } from './runtime-config/index.js';

/**
 * The hosted intent classifier for a room that is being built now (ADR-0024,
 * ADR-0025).
 *
 * A factory rather than a value, because the provider is a per-session
 * setting: the room reads it once, keeps what it got for its whole lesson,
 * and the next room reads it again. Classifiers are memoised per (provider,
 * model), so building a room costs a map lookup.
 *
 * `model` returns null and a turn the local heuristics cannot place goes to
 * the session's own model exactly as it always has; the room owns that path
 * and always has it, so a null here is a configuration, never a missing
 * dependency.
 *
 * `jev` without `OPENROUTER_API_KEY` also returns null, and says so once.
 * This used to be fatal at boot, and could not stay fatal once the provider
 * became something a dashboard can change: refusing to build a room because
 * somebody flipped a setting would turn a configuration mistake into an
 * outage, when the model path is right there and costs a learner nothing.
 */
export function createIntentClassifier(
  cfg: Config,
  config: RuntimeConfigStore,
  meter?: CostMeter,
): () => IntentClassifier | null {
  const built = new Map<string, IntentClassifier | null>();
  let warnedAboutKey = false;
  return () => {
    const provider = config.get('PEN_INTENT_PROVIDER');
    if (provider === 'model') return null;
    if (!cfg.OPENROUTER_API_KEY) {
      if (!warnedAboutKey) {
        warnedAboutKey = true;
        logger.warn(
          { evt: 'intent.no_key' },
          'PEN_INTENT_PROVIDER=jev has no OPENROUTER_API_KEY; rooms classify with the session model',
        );
      }
      return null;
    }
    const model = config.get('PEN_INTENT_MODEL');
    const cacheId = `${provider}:${model}`;
    const cached = built.get(cacheId);
    if (cached !== undefined) return cached;
    logger.info(
      { evt: 'intent.provider', model, timeoutMs: INTENT_TIMEOUT_MS },
      'intent classified by a hosted decisions model; the session model stays as the fallback',
    );
    const classifier = new JevIntentClassifier({
      decisions: new JevDecisionsModel({
        apiKey: cfg.OPENROUTER_API_KEY,
        model,
        timeoutMs: INTENT_TIMEOUT_MS,
        ...(meter ? { meter } : {}),
      }),
    });
    built.set(cacheId, classifier);
    return classifier;
  };
}
