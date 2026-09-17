import type { PreparationProgress } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { ProgressReporter, stageIndex } from '../src/progress.js';

describe('ProgressReporter', () => {
  it('never lets fraction, stage or counters walk backwards, except into failed', () => {
    const seen: PreparationProgress[] = [];
    const r = new ProgressReporter((p) => seen.push(p));
    r.report({ stage: 'outlining', fraction: 0.1, status: 'a', sourcesFound: 3, sourcesFetched: 0 });
    r.report({ stage: 'fetching', fraction: 0.4, status: 'b', sourcesFound: 3, sourcesFetched: 1 });
    r.report({ stage: 'discovering', fraction: 0.2, status: 'c', sourcesFound: 10, sourcesFetched: 1 });
    r.report({ stage: 'ready', fraction: 0.85, status: 'd', sourcesFound: 10, sourcesFetched: 2 });
    r.report({ stage: 'failed', fraction: 0.5, status: 'e', sourcesFound: 10, sourcesFetched: 2 });
    expect(seen.map((p) => p.stage)).toEqual(['outlining', 'fetching', 'fetching', 'ready', 'failed']);
    expect(seen.map((p) => p.fraction)).toEqual([0.1, 0.4, 0.4, 0.85, 0.85]);
    expect(seen[2]?.status).toBe('c');
    expect(seen[2]?.sourcesFound).toBe(10);
  });

  it('clamps fractions and truncates status lines to 120 characters', () => {
    const seen: PreparationProgress[] = [];
    const r = new ProgressReporter((p) => seen.push(p));
    r.report({ stage: 'resolving', fraction: -1, status: '  many   spaces  ', sourcesFound: 0, sourcesFetched: 0 });
    r.report({ stage: 'qualified', fraction: 7, status: 'x'.repeat(300), sourcesFound: 0, sourcesFetched: 0 });
    expect(seen[0]).toMatchObject({ fraction: 0, status: 'many spaces' });
    expect(seen[1]?.fraction).toBe(1);
    expect(seen[1]?.status).toHaveLength(120);
    expect(seen[1]?.status.endsWith('…')).toBe(true);
  });

  it('orders stages as the Preparing screen expects', () => {
    expect(stageIndex('resolving')).toBeLessThan(stageIndex('outlining'));
    expect(stageIndex('fetching')).toBeLessThan(stageIndex('ready'));
    expect(stageIndex('ready')).toBeLessThan(stageIndex('qualified'));
  });
});
