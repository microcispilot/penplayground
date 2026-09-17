import type { SourceDocument } from '@pen/contracts';
import { addDocumentToPack, newPack } from './compile.js';
import type { PackStore } from './pack-store.js';
import type {
  CompileProgress,
  CompileRequest,
  OntenCompiler,
  Pack,
  ProgressiveCompilation,
  ProvisionalReceipt,
  QualifiedPackReference,
} from './types.js';

/** Units before the interactive promise resolves (first useful context). */
const INTERACTIVE_MIN_UNITS = 6;

/**
 * Mirrors onten/compiler/progressive.ts: one call returns an `interactive`
 * promise (bounded by policy.maxInteractiveWaitMs) and a `background` promise.
 * The host streams documents in via `addSource`; the provisional pack is
 * published as soon as it has a handful of units; qualification runs when the
 * host calls `finishSources`.
 */
export class MockCompiler implements OntenCompiler {
  constructor(private readonly store: PackStore) {}

  startProgressiveCompilation(request: CompileRequest): ProgressiveCompilation {
    const enabled =
      request.policy.allowed &&
      request.policy.progressiveFirstUseEnabled &&
      request.policy.serveProvisionalContextBeforePackQualification &&
      request.policy.backgroundCompileAfterGap &&
      request.policy.allowedSourceClasses.length > 0;
    if (!enabled)
      throw new Error('CTX-PROGRESSIVE-01 host policy does not permit progressive first use');

    const pack: Pack = newPack({
      canonicalKnowledgeId: request.canonicalKnowledgeId,
      title: request.title,
      scope: request.scope,
    });
    const listeners = new Set<(p: CompileProgress) => void>();
    let phase: CompileProgress['phase'] = 'collecting';
    let cancelled = false;
    let finished = false;
    let prepared: QualifiedPackReference | null = null;
    let evaluation: Pack['evaluation'] | undefined;
    const emit = () => {
      const p: CompileProgress = {
        sourcesReceived: pack.sources.length,
        unitsCompiled: pack.units.length,
        phase,
      };
      for (const l of listeners) l(p);
    };

    let resolveInteractive!: (r: ProvisionalReceipt) => void;
    let rejectInteractive!: (e: Error) => void;
    const interactiveInner = new Promise<ProvisionalReceipt>((res, rej) => {
      resolveInteractive = res;
      rejectInteractive = rej;
    });
    let interactiveSettled = false;
    const settleInteractive = (r: ProvisionalReceipt) => {
      if (interactiveSettled) return;
      interactiveSettled = true;
      resolveInteractive(r);
    };
    const deadline = setTimeout(() => {
      if (interactiveSettled) return;
      if (pack.units.length > 0) {
        void this.store.put(pack).then(() => settleInteractive(receiptFor(pack)));
      } else {
        interactiveSettled = true;
        rejectInteractive(
          new Error('CTX-PROGRESSIVE-01 interactive wait exceeded with no usable source'),
        );
      }
    }, request.policy.maxInteractiveWaitMs);

    let resolveBackground!: (r: QualifiedPackReference | null) => void;
    const background = new Promise<QualifiedPackReference | null>((res) => {
      resolveBackground = res;
    });

    const maybeQualify = async () => {
      if (!finished || cancelled || phase === 'qualified' || phase === 'qualifying') return;
      phase = 'qualifying';
      emit();
      // Gates: sources with rights, non-empty units, an evaluation set (development + negative).
      const rightsOk = pack.sources.every((s) => s.rights.ingestionAllowed);
      const evalOk =
        (evaluation?.development.length ?? 0) > 0 && (evaluation?.negative.length ?? 0) > 0;
      if (!rightsOk || pack.units.length === 0 || !evalOk) {
        phase = 'failed';
        emit();
        resolveBackground(null);
        return;
      }
      pack.evaluation = evaluation ?? pack.evaluation;
      pack.qualified = true;
      pack.packRevision = String(Number(pack.packRevision) + 1);
      pack.updatedAt = Date.now();
      await this.store.put(pack);
      prepared = {
        packId: pack.packId,
        packRevision: pack.packRevision,
        digest: pack.digest,
        unitCount: pack.units.length,
      };
      phase = 'qualified';
      emit();
      resolveBackground(prepared);
    };

    const compilation: ProgressiveCompilation = {
      interactive: interactiveInner.finally(() => clearTimeout(deadline)),
      background,
      prepared: () => prepared,
      cancelBackground: () => {
        cancelled = true;
        phase = 'cancelled';
        emit();
        resolveBackground(null);
      },
      addSource: async (document: SourceDocument) => {
        if (cancelled || finished) return;
        addDocumentToPack(pack, document);
        await this.store.put(pack);
        if (!interactiveSettled && pack.units.length >= INTERACTIVE_MIN_UNITS) {
          phase = 'provisional';
          settleInteractive(receiptFor(pack));
        }
        emit();
      },
      finishSources: (ev) => {
        if (finished) return;
        finished = true;
        evaluation = ev;
        if (!interactiveSettled) {
          if (pack.units.length > 0) settleInteractive(receiptFor(pack));
          else {
            interactiveSettled = true;
            rejectInteractive(new Error('CTX-PROGRESSIVE-01 no usable source'));
          }
        }
        void maybeQualify();
      },
      onProgress: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return compilation;
  }
}

function receiptFor(pack: Pack): ProvisionalReceipt {
  return {
    status: pack.units.length > 0 ? 'partial' : 'missing',
    evidenceTier: 'unverified_live_source',
    attribution: [...new Set(pack.sources.map((s) => s.rights.attribution || s.title))].join('; '),
    mayAuthorizeConsequentialDecision: false,
    packId: pack.packId,
    unitCount: pack.units.length,
    cost: 0,
  };
}
