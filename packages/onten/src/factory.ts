import type { SourceDocument } from '@pen/contracts';
import { FilePackStore, MemoryPackStore, type PackStore } from './pack-store.js';
import { PEN_HOST_POLICY } from './policy.js';
import { MockCompiler } from './progressive.js';
import { canonicalKnowledgeIdFor, inferDomain, MockRegistry } from './registry.js';
import { MockContextRuntime } from './runtime.js';
import type {
  HostContextPolicy,
  OntenCompiler,
  OntenRegistry,
  Pack,
  QualifiedPackReference,
  ScopeDescriptor,
} from './types.js';

/** What `learn` needs to turn documents into an answerable pack. */
export interface LearnRequest {
  /** Omit to derive it from `title` (`en.how-transformers-work-in-llms`). */
  canonicalKnowledgeId?: string;
  title: string;
  /** Omit and Onten derives the scope — language, locale and domain — from the title. */
  scope?: Partial<ScopeDescriptor>;
  documents: SourceDocument[];
  /**
   * The development + negative questions the compile contract requires for
   * qualification. Without them the pack stays provisional: nothing is ever
   * auto-promoted.
   */
  evaluation?: Pack['evaluation'];
  requestId?: string;
  hostId?: string;
}

export interface Onten {
  store: PackStore;
  registry: OntenRegistry;
  compiler: OntenCompiler;
  policy: HostContextPolicy;
  /**
   * **Give Onten information.** The one way in: hand it documents and get back
   * the pack they became, ready to answer from. Everything else — the corpus
   * builder's live streaming, the built-in seed packs — is this same path with
   * the documents arriving one at a time (`compiler.startProgressiveCompilation`).
   *
   * A runtime created after this call answers from the pack immediately; a
   * runtime already configured on it picks the new revision up on
   * `refreshPacks()`.
   *
   * Returns the qualified pack, or null when it could not qualify (no usable
   * document, missing rights, or no evaluation set) — in which case the pack
   * exists and is answerable, but provisionally.
   */
  learn(request: LearnRequest): Promise<QualifiedPackReference | null>;
  /** One runtime per session: configure() with that session's packs. */
  newRuntime(): MockContextRuntime;
}

export function createOnten(opts: { dataDir?: string; policy?: HostContextPolicy } = {}): Onten {
  const store = opts.dataDir ? new FilePackStore(`${opts.dataDir}/packs`) : new MemoryPackStore();
  const policy = opts.policy ?? PEN_HOST_POLICY;
  const compiler = new MockCompiler(store);
  return {
    store,
    policy,
    compiler,
    registry: new MockRegistry(store),
    newRuntime: () => new MockContextRuntime(store),
    learn: async (request) => {
      const language = request.scope?.language ?? 'en';
      const canonicalKnowledgeId =
        request.canonicalKnowledgeId ?? canonicalKnowledgeIdFor(request.title, language);
      const compilation = compiler.startProgressiveCompilation({
        requestId: request.requestId ?? `learn-${canonicalKnowledgeId}`,
        hostId: request.hostId ?? 'pen',
        canonicalKnowledgeId,
        title: request.title,
        scope: {
          conceptOrTopicBoundary: request.scope?.conceptOrTopicBoundary ?? request.title,
          language,
          locale: request.scope?.locale ?? 'en-US',
          domainBoundary: request.scope?.domainBoundary ?? inferDomain(request.title),
        },
        policy: policy.expansion,
      });
      // `interactive` rejects when not one document was usable, and its
      // deadline timer can reject it at any moment — so it is handled before
      // the first `await` below, not after. Attached later, a throw from
      // `addSource` would leave that rejection unhandled.
      const interactive = compilation.interactive.catch(() => undefined);
      // Documents reach the compiler in order, one at a time, exactly as the
      // corpus builder streams them.
      for (const document of request.documents) await compilation.addSource(document);
      compilation.finishSources(request.evaluation);
      await interactive;
      return compilation.background;
    },
  };
}
