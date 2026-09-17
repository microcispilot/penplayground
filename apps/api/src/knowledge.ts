import type { KnowledgeAcquirer } from '@pen/session-engine';
import type { Services } from './services.js';

/**
 * Topic-miss acquisition wiring. Bound to `@pen/knowledge` once that package
 * lands; until then sessions on unknown topics fail honestly rather than
 * pretending to prepare.
 */
export function createAcquirer(_services: Omit<Services, 'acquirer'>): KnowledgeAcquirer | null {
  return null;
}
