import { CorpusBuilder, chooseSearchProvider } from '@pen/knowledge';
import type { KnowledgeAcquirer } from '@pen/session-engine';
import { observer } from './observability.js';
import type { Services } from './services.js';

/**
 * Topic-miss acquisition: the corpus builder streams licensed sources into
 * Onten's progressive compiler. The outline/evalset model is the free-plan
 * key's model (cheap, cached); search is SearXNG → Tavily → Exa → curated seeds only.
 */
export function createAcquirer(services: Omit<Services, 'acquirer'>): KnowledgeAcquirer | null {
  let model: ReturnType<Services['modelFor']>;
  try {
    model = services.modelFor('free');
  } catch (error) {
    observer.error('knowledge.no_model', error);
    return null;
  }
  const env = {
    SEARXNG_URL: services.cfg.SEARXNG_URL,
    TAVILY_API_KEY: services.cfg.TAVILY_API_KEY,
    EXA_API_KEY: services.cfg.EXA_API_KEY,
  };
  return new CorpusBuilder({
    compiler: services.onten.compiler,
    model,
    policy: services.onten.policy,
    search: chooseSearchProvider(env, { observer }),
    observer,
    hostId: 'pen',
  });
}
