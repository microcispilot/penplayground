import type { FeatureFlagsMutation, FeatureFlagsRollback } from '@pen/contracts';
import * as Sentry from '@sentry/react';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { writeFailure } from '../../lib/api.js';
import { useAdmin } from '../../lib/context.js';
import {
  type FeaturesEditorState,
  type FeaturesHistoryState,
  featuresHistoryReducer,
  featuresReducer,
  initialFeaturesHistory,
  initialFeaturesState,
} from '../../lib/features-state.js';

export interface FeaturesController {
  state: FeaturesEditorState;
  history: FeaturesHistoryState;
  edit: (draft: FeaturesEditorState['draft']) => void;
  load: () => Promise<void>;
  loadHistory: (beforeRevision?: number) => Promise<void>;
  save: (body: FeatureFlagsMutation) => Promise<boolean>;
  rollback: (body: FeatureFlagsRollback) => Promise<boolean>;
}

/**
 * The wiring between the Features editor's state machine and the API
 * (ADR-0036): the same shape as `useRuntimeConfig`, for the same reasons —
 * a monotonic request id so a slow answer never overwrites a newer one, and
 * no read while a write is in flight.
 */
export function useFeatures(): FeaturesController {
  const { api, signOut } = useAdmin();
  const [state, dispatch] = useReducer(featuresReducer, initialFeaturesState);
  const [history, dispatchHistory] = useReducer(featuresHistoryReducer, initialFeaturesHistory);
  const nextRequest = useRef(0);
  const nextHistoryRequest = useRef(0);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const historyRead = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (write.current !== null) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const requestId = ++nextRequest.current;
    dispatch({ type: 'LOAD', requestId });
    try {
      const document = await api.features(controller.signal);
      if (!controller.signal.aborted) dispatch({ type: 'LOADED', requestId, document });
    } catch (error) {
      if (!controller.signal.aborted) {
        Sentry.captureException(error);
        dispatch({
          type: 'LOAD_FAILED',
          requestId,
          error: 'The features could not be read. Try again to see the revision in force.',
        });
      }
    } finally {
      if (read.current === controller) read.current = null;
    }
  }, [api]);

  const loadHistory = useCallback(
    async (beforeRevision?: number) => {
      historyRead.current?.abort();
      const controller = new AbortController();
      historyRead.current = controller;
      const requestId = ++nextHistoryRequest.current;
      dispatchHistory({ type: 'LOAD', requestId });
      try {
        const page = await api.featuresHistory(beforeRevision, controller.signal);
        if (!controller.signal.aborted)
          dispatchHistory({
            type: 'LOADED',
            requestId,
            history: page,
            ...(beforeRevision === undefined ? {} : { beforeRevision }),
          });
      } catch (error) {
        if (!controller.signal.aborted) {
          Sentry.captureException(error);
          dispatchHistory({ type: 'FAILED', requestId });
        }
      } finally {
        if (historyRead.current === controller) historyRead.current = null;
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
    void loadHistory();
    return () => {
      read.current?.abort();
      historyRead.current?.abort();
      // Never the write: it has left the browser and the server will commit it.
    };
  }, [load, loadHistory]);

  const mutate = async (
    run: (signal: AbortSignal) => Promise<Awaited<ReturnType<typeof api.features>>>,
    expectedRevision: number,
    notice: (revision: number) => string,
  ): Promise<boolean> => {
    if (state.phase !== 'READY' || state.document === null || write.current !== null) return false;
    if (expectedRevision !== state.document.revision) return false;
    read.current?.abort();
    const controller = new AbortController();
    write.current = controller;
    const requestId = ++nextRequest.current;
    dispatch({ type: 'SAVE', requestId });
    try {
      const document = await run(controller.signal);
      if (controller.signal.aborted) return false;
      dispatch({ type: 'SAVED', requestId, document, notice: notice(document.revision) });
      void loadHistory();
      return document.revision === expectedRevision + 1;
    } catch (error) {
      if (!controller.signal.aborted) {
        Sentry.captureException(error);
        const failure = writeFailure(error);
        if (failure.signedOut) signOut();
        dispatch({
          type: 'SAVE_FAILED',
          requestId,
          error: failure.message,
          reloadRequired: failure.reloadRequired,
        });
      }
      return false;
    } finally {
      if (write.current === controller) write.current = null;
    }
  };

  return {
    state,
    history,
    edit: (draft) => dispatch({ type: 'EDIT', draft }),
    load,
    loadHistory,
    save: (body) =>
      mutate(
        (signal) => api.saveFeatures(body, signal),
        body.expectedRevision,
        (revision) => `Saved as revision ${revision}.`,
      ),
    rollback: (body) =>
      mutate(
        (signal) => api.rollbackFeatures(body, signal),
        body.expectedRevision,
        (revision) => `Restored revision ${body.targetRevision} as revision ${revision}.`,
      ),
  };
}
