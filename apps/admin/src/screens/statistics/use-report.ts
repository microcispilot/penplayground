import * as Sentry from '@sentry/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminApi } from '../../lib/api.js';
import { useAdmin } from '../../lib/context.js';

export interface ReportState<T> {
  data: T | null;
  /** The first load, with nothing on screen yet. */
  loading: boolean;
  /** A later load, with the previous answer still on screen. */
  refreshing: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * One report, fetched and kept (ADR-0027).
 *
 * Three behaviours, and each of them is there because the alternative is
 * worse on a dashboard:
 *
 *   · **The previous answer stays while the next one loads.** Changing the
 *     range must not blank the page; a chart that disappears and comes back
 *     reads as a fault, and the product bar forbids a still screen. The page
 *     dims instead, and says it is updating.
 *   · **A slow answer can never overwrite a newer one.** Every request
 *     carries a monotonic id and an `AbortController`, exactly as the
 *     settings editor does — click three ranges quickly and the third is
 *     what you are looking at.
 *   · **A failure is a sentence, not an empty page.** The error is shown
 *     with a way to try again, and sent to Sentry.
 *
 * `deps` is the request's identity: the resolved window, the bucket, the
 * filters. Anything the fetcher reads must be in it.
 */
export function useReport<T>(
  fetcher: (api: AdminApi, signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): ReportState<T> {
  const { api } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The fetcher is a closure rebuilt every render; keeping it in a ref means
  // `deps` alone decides when a request is made, which is the point.
  const run = useRef(fetcher);
  run.current = fetcher;
  const nextRequest = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const hasData = useRef(false);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's declaration of what identifies this request, and `attempt` is the reload trigger — neither is read in the body, and the fetcher is held in a ref precisely so it cannot re-trigger a request
  useEffect(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const id = ++nextRequest.current;
    if (hasData.current) setRefreshing(true);
    else setLoading(true);
    void (async () => {
      try {
        const answer = await run.current(api, controller.signal);
        if (controller.signal.aborted || id !== nextRequest.current) return;
        hasData.current = true;
        setData(answer);
        setError(null);
      } catch (thrown) {
        if (controller.signal.aborted || id !== nextRequest.current) return;
        Sentry.captureException(thrown);
        setError(
          thrown instanceof Error && thrown.message
            ? thrown.message
            : 'That report could not be read.',
        );
      } finally {
        if (!controller.signal.aborted && id === nextRequest.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    return () => controller.abort();
  }, [api, attempt, ...deps]);

  return { data, loading, refreshing, error, reload };
}
