import {
  type CostMeter,
  JevDecisionsModel,
  TYPESAFE_DIRECT_BASE_URL,
  TYPESAFE_DIRECT_MODEL,
} from '@pen/llm';
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
    /*
     * TypeSafe's own endpoint when we have TypeSafe's own key, the gateway
     * otherwise. Direct wins when both are set: OpenRouter only ever existed
     * to reach this model, so going through it is a hop and a markup for
     * nothing.
     *
     * The id travels with the route rather than with the model — TypeSafe
     * refuses `typesafe/jev-1.13` and OpenRouter refuses `jev-latest`, both
     * with a 400 — so `PEN_INTENT_MODEL` is honoured only on the gateway path.
     * Letting an operator point a pinned gateway id at TypeSafe would be a
     * setting that reads as configured and fails every call.
     */
    const direct = cfg.PEN_TYPESAFE_API_KEY;
    const apiKey = direct ?? cfg.OPENROUTER_API_KEY;
    if (!apiKey) {
      if (!warnedAboutKey) {
        warnedAboutKey = true;
        logger.warn(
          { evt: 'intent.no_key' },
          'PEN_INTENT_PROVIDER=jev has no PEN_TYPESAFE_API_KEY or OPENROUTER_API_KEY; rooms classify with the session model',
        );
      }
      return null;
    }
    const model = direct ? TYPESAFE_DIRECT_MODEL : config.get('PEN_INTENT_MODEL');
    const route = direct ? 'typesafe' : 'openrouter';
    const cacheId = `${provider}:${route}:${model}`;
    const cached = built.get(cacheId);
    if (cached !== undefined) return cached;
    logger.info(
      { evt: 'intent.provider', model, route, timeoutMs: INTENT_TIMEOUT_MS },
      'intent classified by a hosted decisions model; the session model stays as the fallback',
    );
    const classifier = new JevIntentClassifier({
      decisions: new JevDecisionsModel({
        apiKey,
        model,
        timeoutMs: INTENT_TIMEOUT_MS,
        ...(direct ? { baseUrl: TYPESAFE_DIRECT_BASE_URL } : {}),
        ...(meter ? { meter } : {}),
      }),
    });
    built.set(cacheId, classifier);
    return classifier;
  };
}
