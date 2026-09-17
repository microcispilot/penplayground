import type { PreparationProgress } from '@pen/contracts';
import type { LanguageModel } from '@pen/llm';
import type {
  HostContextPolicy,
  OntenCompiler,
  QualifiedPackReference,
  TopicResolution,
} from '@pen/onten';
import type { Seed } from './seeds.js';

/** Same shape as `RoomObserver` in @pen/session-engine: structured events + errors, never throws. */
export interface KnowledgeObserver {
  event(name: string, data: Record<string, unknown>): void;
  error(area: string, error: unknown, data?: Record<string, unknown>): void;
}

export const SILENT_KNOWLEDGE_OBSERVER: KnowledgeObserver = {
  event: () => undefined,
  error: () => undefined,
};

// ── search seam ──────────────────────────────────────────────────────────────
export interface SearchHit {
  url: string;
  title: string;
  /** Provider snippet; doubles as the excerpt for sources we may not ingest. */
  snippet: string;
  /** Provider relevance, 0–1 when known. */
  score: number | null;
}

export interface SearchRequest {
  query: string;
  maxResults: number;
  signal: AbortSignal;
}

/** One web search backend. Adapters: SearxngSearch, TavilySearch, ExaSearch, NoSearch. */
export interface SearchProvider {
  readonly name: string;
  search(request: SearchRequest): Promise<SearchHit[]>;
}

// ── fetch targets & transforms ───────────────────────────────────────────────
/** Source-specific clean-up applied after fetching, before Onten sees the text. */
export type Transform = 'none' | 'docc' | 'mdbook' | 'mdn' | 'wikipedia-extract';

export type TargetOrigin = 'seed' | 'outline' | 'search';

export interface FetchTarget {
  url: string;
  /** Preferred title when the page carries none. */
  title: string | null;
  origin: TargetOrigin;
  /** Human label for status lines ("the Swift language guide", "docs.python.org"). */
  label: string;
  seedId: string | null;
  /** Search snippet; used as the excerpt for blocked sources so they are never fetched. */
  snippet: string | null;
  transform: Transform;
  /** Declared API endpoint: exempt from robots.txt (Wikimedia API etiquette applies instead). */
  api: boolean;
  /** Lower runs first. Seeds < outline candidates < search hits. */
  priority: number;
}

/** A source we may cite but never ingest (e.g. developer.apple.com). */
export interface Reference {
  url: string;
  title: string;
  /** At most 300 characters. */
  excerpt: string;
  license: string;
}

export interface CorpusOutline {
  curriculum: string[];
  queries: string[];
  candidateUrls: string[];
}

// ── budget ───────────────────────────────────────────────────────────────────
export interface Budget {
  /** Hard cap on search API calls per topic. */
  maxSearches: number;
  /** Hard cap on document fetches per topic (robots.txt lookups and mdbook includes excluded). */
  maxPages: number;
  /** Non-seed pages per host, for diversity and to keep the per-host rate limit from dominating. */
  maxPagesPerHost: number;
  /** Wall-clock budget for the background phase; fetching stops here, qualification still runs. */
  backgroundMs: number;
  /** Parallel fetches. */
  concurrency: number;
  /** Minimum gap between two requests to the same host. */
  perHostGapMs: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Bodies larger than this are truncated. */
  maxPageBytes: number;
  /** Parallel searches. */
  searchConcurrency: number;
  /** Results requested per search. */
  resultsPerSearch: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxSearches: 50,
  maxPages: 120,
  maxPagesPerHost: 24,
  backgroundMs: 4 * 60_000,
  concurrency: 6,
  perHostGapMs: 500,
  timeoutMs: 8_000,
  maxPageBytes: 2 * 1024 * 1024,
  searchConcurrency: 3,
  resultsPerSearch: 5,
};

// ── builder ──────────────────────────────────────────────────────────────────
export interface CorpusBuilderOptions {
  compiler: OntenCompiler;
  model: LanguageModel;
  policy: HostContextPolicy;
  /** Defaults to the provider chosen from the environment (SearXNG → Tavily → Exa → none). */
  search?: SearchProvider;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  observer?: KnowledgeObserver;
  budget?: Partial<Budget>;
  /** Curated allowlist; defaults to `SEEDS`. */
  seeds?: Seed[];
  hostId?: string;
  userAgent?: string;
  locale?: string;
  now?: () => number;
}

export interface PreparedCorpus {
  packId: string;
  provisional: boolean;
  /** Resolves with the qualified pack, or null when cancelled / failed qualification. */
  background: Promise<QualifiedPackReference | null>;
  /** The model's curriculum + queries; may still be in flight when the seeds alone made the pack ready. Never rejects. */
  outline: Promise<CorpusOutline>;
  /** Sources we may cite but not ingest; grows while the background phase runs. */
  references: Reference[];
}

export interface PrepareArgs {
  resolution: TopicResolution;
  onProgress: (progress: PreparationProgress) => void;
  signal: AbortSignal;
}
