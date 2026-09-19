import type { RuntimeConfigMutation, RuntimeConfigRollback } from '@pen/contracts';
import * as Sentry from '@sentry/react';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { writeFailure } from '../../lib/api.js';
import { useAdmin } from '../../lib/context.js';
import {
  type EditorState,
  editorReducer,
  type HistoryState,
  historyReducer,
  initialEditorState,
  initialHistoryState,
} from '../../lib/runtime-config-state.js';

export interface RuntimeConfigController {
  state: EditorState;
  history: HistoryState;
  edit: (draft: EditorState['draft']) => void;
  load: () => Promise<void>;
  loadHistory: (beforeRevision?: number) => Promise<void>;
  save: (body: RuntimeConfigMutation) => Promise<boolean>;
  rollback: (body: RuntimeConfigRollback) => Promise<boolean>;
}

/**
 * The wiring between the editor's state machine and the API (ADR-0026).
 *
 * Everything worth arguing about is in the reducer; this owns only the two
 * things a reducer cannot: cancelling a request that has been overtaken, and
 * refusing to start a read while a write is in flight. A monotonic request id
 * means a slow answer can never overwrite a newer one.
 */
export function useRuntimeConfig(): RuntimeConfigController {
  const { api, signOut } = useAdmin();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const [history, dispatchHistory] = useReducer(historyReducer, initialHistoryState);
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
      const document = await api.runtimeConfig(controller.signal);
      if (!controller.signal.aborted) dispatch({ type: 'LOADED', requestId, document });
    } catch (error) {
      if (!controller.signal.aborted) {
        Sentry.captureException(error);
        dispatch({
          type: 'LOAD_FAILED',
          requestId,
          error: 'The settings could not be read. Try again to see the revision in force.',
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
        const page = await api.runtimeConfigHistory(beforeRevision, controller.signal);
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
      // Deliberately NOT the write. That request has left the browser and the
      // server will commit it; aborting only throws away the answer, so the
      // operator never learns which revision they created.
    };
  }, [load, loadHistory]);

  const mutate = async (
    run: (signal: AbortSignal) => Promise<Awaited<ReturnType<typeof api.runtimeConfig>>>,
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
        // A bearer the server no longer accepts must not stay in this
        // browser: drop it and put the sign-in screen back.
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
        (signal) => api.saveRuntimeConfig(body, signal),
        body.expectedRevision,
        (revision) => `Saved as revision ${revision}.`,
      ),
    rollback: (body) =>
      mutate(
        (signal) => api.rollbackRuntimeConfig(body, signal),
        body.expectedRevision,
        (revision) => `Restored revision ${body.targetRevision} as revision ${revision}.`,
      ),
  };
}
