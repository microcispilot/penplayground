import type { PreparationProgress, PreparationStage } from '@pen/contracts';

const STAGE_ORDER: PreparationStage[] = [
  'resolving',
  'outlining',
  'discovering',
  'fetching',
  'compiling',
  'ready',
  'qualified',
  'failed',
];

/** Fraction reached when the interactive pack is ready; the room reports its own planning at 0.9. */
export const READY_FRACTION = 0.85;

const MAX_STATUS = 120;

/**
 * Emits `PreparationProgress` with a monotonic `fraction` and a monotonic
 * stage (the pipeline overlaps seed reading with outlining and searching; the
 * status line stays honest, the coarse stage never walks backwards).
 */
export class ProgressReporter {
  private last: PreparationProgress | null = null;

  constructor(private readonly emit: (progress: PreparationProgress) => void) {}

  get current(): PreparationProgress | null {
    return this.last;
  }

  report(next: PreparationProgress): PreparationProgress {
    const prev = this.last;
    const stage = next.stage === 'failed' ? 'failed' : laterStage(prev?.stage ?? null, next.stage);
    const progress: PreparationProgress = {
      stage,
      fraction: clamp(Math.max(prev?.fraction ?? 0, next.fraction)),
      status: truncate(next.status),
      sourcesFound: Math.max(prev?.sourcesFound ?? 0, next.sourcesFound),
      sourcesFetched: Math.max(prev?.sourcesFetched ?? 0, next.sourcesFetched),
    };
    this.last = progress;
    this.emit(progress);
    return progress;
  }
}

function laterStage(prev: PreparationStage | null, next: PreparationStage): PreparationStage {
  if (!prev) return next;
  return STAGE_ORDER.indexOf(next) >= STAGE_ORDER.indexOf(prev) ? next : prev;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

function truncate(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_STATUS ? clean : `${clean.slice(0, MAX_STATUS - 1)}…`;
}

export function stageIndex(stage: PreparationStage): number {
  return STAGE_ORDER.indexOf(stage);
}
