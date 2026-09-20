import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  type RangeChoice,
  type ReportRange,
  readChoice,
  resolveRange,
  writeChoice,
} from '../../lib/range.js';

export interface RangeController {
  range: ReportRange;
  choice: RangeChoice;
  set: (choice: RangeChoice) => void;
  /** Re-anchor "the last thirty days" to now and re-read every report. */
  refresh: () => void;
  /** Changes whenever the resolved window does; a report's dependency key. */
  key: string;
}

/**
 * The chosen range, read from the URL and resolved against a fixed moment.
 *
 * The fixed moment is the whole trick. `resolveRange(choice, Date.now())`
 * called during render returns a different window every frame, every report
 * sees new dependencies, and the console refetches itself forever. So *now*
 * is captured once per choice and held until the choice changes or the
 * operator asks for a refresh — which is also the behaviour a reader wants:
 * numbers that stay still while they are being read.
 */
export function useRange(): RangeController {
  const [params, setParams] = useSearchParams();
  const [refreshes, setRefreshes] = useState(0);
  const choice = readChoice(params);
  const choiceKey = `${choice.presetId}|${choice.fromDate ?? ''}|${choice.toDate ?? ''}|${
    choice.bucket ?? ''
  }|${refreshes}`;
  const anchor = useRef<{ key: string; at: number }>({ key: choiceKey, at: Date.now() });
  if (anchor.current.key !== choiceKey) anchor.current = { key: choiceKey, at: Date.now() };
  const range = resolveRange(choice, anchor.current.at);

  const set = useCallback(
    (next: RangeChoice) => {
      setParams((current) => writeChoice(current, next), { replace: true });
    },
    [setParams],
  );

  return {
    range,
    choice,
    set,
    refresh: () => setRefreshes((n) => n + 1),
    key: `${range.from}|${range.to}|${range.bucket}`,
  };
}
