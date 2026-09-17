import type { HostContextPolicy } from './types.js';

/** Pen Academy's trusted host policy: progressive first use on, informational only. */
export const PEN_HOST_POLICY: HostContextPolicy = {
  policyId: 'pen-academy-tutor',
  revision: '1',
  allowedDomainsOrTopics: ['*'],
  crossTopicBehavior: 'ask_before_switch',
  expansion: {
    allowed: true,
    allowedSourceClasses: ['curated_open_docs', 'public_docs', 'approved_web'],
    maxInteractiveWaitMs: 20_000,
    maxCostPerExpansion: 1.0,
    backgroundCompileAfterGap: true,
    requiresUserNoticeWhenSlowPath: true,
    progressiveFirstUseEnabled: true,
    serveProvisionalContextBeforePackQualification: true,
  },
  sufficiencyThreshold: 0.42,
};
