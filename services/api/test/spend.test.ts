import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CostLine, LedgerEntry } from '@pen/contracts';
import { utcDayStart } from '@pen/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { SpendBreaker } from '../src/spend.js';

/**
 * The circuit breaker in front of the day's provider spend (ADR-0016), driven
 * by an injected clock so the UTC-midnight reset is a test rather than a wait.
 */
const DAY = 86_400_000;

function costLine(usd: number, component: CostLine['component'] = 'llm'): CostLine {
  return {
    component,
    unit: component === 'ads' ? 'requests' : 'tokens_in',
    units: 1,
    usd,
    meta: {},
  };
}

const dirs: string[] = [];
function tempSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pen-spend-'));
  dirs.push(dir);
  return dir;
}

/** A ledger on disk, exactly as `FileLedger` writes it: one JSON entry per line. */
function writeLedger(sessionsDir: string, sessionId: string, entries: LedgerEntry[]): void {
  mkdirSync(join(sessionsDir, sessionId), { recursive: true });
  writeFileSync(
    join(sessionsDir, sessionId, 'ledger.jsonl'),
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SpendBreaker', () => {
  it('follows a cap that moves under it, because the cap is a runtime setting', () => {
    // The point of a circuit breaker is being able to move it while the fire
    // is burning (ADR-0025). A breaker that captured its cap at construction
    // would pass every other test in this file and fail this one.
    let capUsd = 10;
    let paidMultiple = 2;
    const breaker = new SpendBreaker({ capUsd: () => capUsd, paidMultiple: () => paidMultiple });
    breaker.record(costLine(12));
    expect(breaker.check('free').ok).toBe(false);
    expect(breaker.check('professional').ok).toBe(true);

    capUsd = 100;
    expect(breaker.check('free')).toEqual({ ok: true, usd: 12, limitUsd: 100 });

    capUsd = 5;
    expect(breaker.check('free').ok).toBe(false);
    paidMultiple = 10;
    expect(breaker.check('professional')).toEqual({ ok: true, usd: 12, limitUsd: 50 });

    // And zero still turns it off, whenever it is set.
    capUsd = 0;
    expect(breaker.enabled).toBe(false);
    expect(breaker.check('free').ok).toBe(true);
  });

  it('is disabled at a cap of 0, and says so rather than silently allowing everything', () => {
    const breaker = new SpendBreaker({ capUsd: () => 0, paidMultiple: () => 3 });
    expect(breaker.enabled).toBe(false);
    expect(breaker.capUsd).toBe(0);
    breaker.record(costLine(500));
    for (const plan of ['free', 'standard', 'professional'] as const)
      expect(breaker.check(plan).ok).toBe(true);
    // Still counted, so the Insights tab and /api/health stay truthful.
    expect(breaker.snapshot().usd).toBe(500);
  });

  it('sums provider spend and keeps ad revenue out of the capped total', () => {
    const breaker = new SpendBreaker({ capUsd: () => 25, paidMultiple: () => 3 });
    breaker.record(costLine(1.5, 'llm'));
    breaker.record(costLine(0.25, 'tts'));
    breaker.record(costLine(0.2, 'stt'));
    breaker.record(costLine(0.05, 'search'));
    breaker.record(costLine(0.5, 'onten'));
    const beforeAds = breaker.snapshot().usd;
    expect(beforeAds).toBeCloseTo(2.5, 10);

    breaker.record(costLine(10, 'ads'));
    const after = breaker.snapshot();
    expect(after.usd).toBeCloseTo(beforeAds, 10);
    expect(after.revenueUsd).toBe(10);
    expect(after.capUsd).toBe(25);
  });

  it('holds free sessions at the cap while paid plans continue to the multiple', () => {
    const breaker = new SpendBreaker({ capUsd: () => 10, paidMultiple: () => 3 });
    expect(breaker.limitFor('free')).toBe(10);
    expect(breaker.limitFor('standard')).toBe(30);
    expect(breaker.limitFor('professional')).toBe(30);

    breaker.record(costLine(9.99));
    expect(breaker.check('free').ok).toBe(true);

    breaker.record(costLine(0.01));
    const free = breaker.check('free');
    expect(free.ok).toBe(false);
    expect(free.limitUsd).toBe(10);
    expect(free.usd).toBeCloseTo(10, 10);
    expect(breaker.check('standard').ok).toBe(true);
    expect(breaker.check('professional').ok).toBe(true);

    breaker.record(costLine(20));
    expect(breaker.check('standard').ok).toBe(false);
    expect(breaker.check('professional').ok).toBe(false);
  });

  it('warns once, at the first crossing of 80 % of the cap', () => {
    const seen: Array<{ usd: number; capUsd: number; fraction: number }> = [];
    const breaker = new SpendBreaker({
      capUsd: () => 10,
      paidMultiple: () => 3,
      onWarning: (info) => seen.push(info),
    });
    breaker.record(costLine(7.9));
    expect(seen).toHaveLength(0);

    breaker.record(costLine(0.1));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.capUsd).toBe(10);
    expect(seen[0]?.usd).toBeCloseTo(8, 10);
    expect(seen[0]?.fraction).toBeCloseTo(0.8, 10);

    // Every later line is past the threshold too; one page is enough.
    breaker.record(costLine(5));
    breaker.record(costLine(5));
    expect(seen).toHaveLength(1);
  });

  it('resets the total, the revenue and the warning latch at the next UTC midnight', () => {
    const start = Date.UTC(2026, 8, 17, 22, 30);
    let clock = start;
    const seen: number[] = [];
    const breaker = new SpendBreaker({
      capUsd: () => 10,
      paidMultiple: () => 3,
      onWarning: ({ usd }) => seen.push(usd),
      now: () => clock,
    });
    breaker.record(costLine(11));
    breaker.record(costLine(2, 'ads'));
    expect(breaker.check('free').ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(breaker.snapshot().dayStart).toBe(utcDayStart(start));

    clock = start + 2 * 3_600_000; // past the next UTC midnight
    const next = breaker.snapshot();
    expect(next.dayStart).toBe(utcDayStart(start) + DAY);
    expect(next.usd).toBe(0);
    expect(next.revenueUsd).toBe(0);
    expect(breaker.check('free').ok).toBe(true);

    breaker.record(costLine(8));
    expect(seen).toHaveLength(2); // the latch reset with the day
  });

  it('rebuilds the day from the ledgers on disk, ignoring lines booked before midnight', () => {
    const now = Date.UTC(2026, 8, 17, 9, 0);
    const day = utcDayStart(now);
    const sessionsDir = tempSessionsDir();
    writeLedger(sessionsDir, 's_rebuild1', [
      { kind: 'cost', t: now, line: costLine(1.25, 'llm') },
      { kind: 'cost', t: now, line: costLine(0.75, 'tts') },
      { kind: 'cost', t: now, line: costLine(3, 'ads') },
      { kind: 'join', t: now, participantId: 'p_rebuild_host', name: 'Ada' },
    ]);
    writeLedger(sessionsDir, 's_rebuild2', [
      // Yesterday's spend is yesterday's problem, even in a file touched today.
      { kind: 'cost', t: day - 1_000, line: costLine(99, 'llm') },
      { kind: 'cost', t: now, line: costLine(0.5, 'stt') },
    ]);

    const breaker = new SpendBreaker({ capUsd: () => 25, paidMultiple: () => 3, now: () => now });
    const result = breaker.rebuild(sessionsDir);
    expect(result.sessions).toBe(2);
    expect(result.usd).toBeCloseTo(2.5, 10);
    const snap = breaker.snapshot();
    expect(snap.usd).toBeCloseTo(2.5, 10);
    expect(snap.revenueUsd).toBe(3);
  });

  it('survives a garbage or unreadable ledger without losing the rest of the day', () => {
    const now = Date.UTC(2026, 8, 17, 9, 0);
    const sessionsDir = tempSessionsDir();
    writeLedger(sessionsDir, 's_good', [{ kind: 'cost', t: now, line: costLine(2, 'llm') }]);

    mkdirSync(join(sessionsDir, 's_garbage'), { recursive: true });
    writeFileSync(
      join(sessionsDir, 's_garbage', 'ledger.jsonl'),
      '{"kind":"cost"\nnot json at all\n',
    );
    // A ledger that is a directory cannot be read at all: the scan must go on.
    mkdirSync(join(sessionsDir, 's_unreadable', 'ledger.jsonl'), { recursive: true });

    const breaker = new SpendBreaker({ capUsd: () => 25, paidMultiple: () => 3, now: () => now });
    expect(() => breaker.rebuild(sessionsDir)).not.toThrow();
    expect(breaker.snapshot().usd).toBeCloseTo(2, 10);
  });

  it('rebuilds nothing from a sessions directory that does not exist yet', () => {
    const now = Date.UTC(2026, 8, 17, 9, 0);
    const breaker = new SpendBreaker({ capUsd: () => 25, paidMultiple: () => 3, now: () => now });
    expect(breaker.rebuild(join(tempSessionsDir(), 'never-created'))).toEqual({
      sessions: 0,
      usd: 0,
    });
  });
});
