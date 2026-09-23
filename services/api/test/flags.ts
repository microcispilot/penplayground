import type { FeatureRulesDocument } from '@pen/contracts';

/**
 * Flags for tests whose subject is not the flags (ADR-0036).
 *
 * The compiled-in rules keep topic preparation off the free plan, and the
 * test services build without the seeded packs — so every session a test
 * starts is a topic miss, and a free host would be refused before the thing
 * under test is reached. These rules say what the deployment those tests
 * describe says: anyone may have a topic prepared. `features.test.ts` is
 * where the compiled-in rules themselves are proved.
 */
export const PREPARE_FOR_EVERYONE: FeatureRulesDocument = {
  prepare_new_topics: { default: true, plans: {}, platforms: {}, cells: {} },
};
