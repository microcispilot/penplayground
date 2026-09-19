import type {
  RuntimeConfigDocument,
  RuntimeConfigHistory,
  RuntimeConfigHistoryEntry,
  RuntimeSetting,
  RuntimeSettingValue,
} from '@pen/contracts';

/**
 * The editor's state machine (ADR-0026), as a pure function.
 *
 * It lives outside the hook on purpose: every interesting behaviour here —
 * a late response arriving after a newer one, a failed save keeping the
 * draft, a revision that skipped a number, a history page that does not
 * follow the one before it — is a rule about correctness under concurrency,
 * and a rule like that is worth a test that renders nothing.
 *
 * The one invariant everything else hangs off: **the saved document and the
 * draft are separate, and a write never advances the revision or rebases the
 * draft unless the server said exactly what was expected.**
 */

/** A draft is a value per setting; absent means "leave it at the default". */
export type Draft = Readonly<Record<string, RuntimeSettingValue | null>>;

export interface EditorState {
  readonly document: RuntimeConfigDocument | null;
  readonly draft: Draft;
  readonly phase: 'LOADING' | 'READY' | 'SAVING' | 'RELOAD_REQUIRED' | 'LOAD_FAILED';
  readonly requestId: number;
  readonly dirty: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}

export const initialEditorState: EditorState = {
  document: null,
  draft: {},
  phase: 'LOADING',
  requestId: 0,
  dirty: false,
  error: null,
  notice: null,
};

export type EditorEvent =
  | { readonly type: 'LOAD'; readonly requestId: number }
  | {
      readonly type: 'LOADED';
      readonly requestId: number;
      readonly document: RuntimeConfigDocument;
    }
  | { readonly type: 'LOAD_FAILED'; readonly requestId: number; readonly error: string }
  | { readonly type: 'EDIT'; readonly draft: Draft }
  | { readonly type: 'SAVE'; readonly requestId: number }
  | {
      readonly type: 'SAVED';
      readonly requestId: number;
      readonly document: RuntimeConfigDocument;
      readonly notice: string;
    }
  | {
      readonly type: 'SAVE_FAILED';
      readonly requestId: number;
      readonly error: string;
      readonly reloadRequired: boolean;
    };

/** The draft a document arrives as: exactly its stored overrides, nothing invented. */
export function draftFrom(document: RuntimeConfigDocument): Draft {
  const draft: Record<string, RuntimeSettingValue | null> = {};
  for (const setting of document.settings) draft[setting.name] = setting.storedValue;
  return draft;
}

export function editorReducer(state: EditorState, event: EditorEvent): EditorState {
  switch (event.type) {
    case 'LOAD':
      // A save in flight owns the revision; a read must not race it.
      if (state.phase === 'SAVING' || event.requestId <= state.requestId) return state;
      return { ...state, phase: 'LOADING', requestId: event.requestId, error: null, notice: null };
    case 'LOADED':
      if (event.requestId !== state.requestId || state.phase !== 'LOADING') return state;
      return accepted(state, event.document, null);
    case 'LOAD_FAILED':
      if (event.requestId !== state.requestId || state.phase !== 'LOADING') return state;
      return { ...state, phase: 'LOAD_FAILED', error: event.error };
    case 'EDIT':
      if (state.phase !== 'READY') return state;
      return { ...state, draft: { ...event.draft }, dirty: true, error: null, notice: null };
    case 'SAVE':
      if (state.phase !== 'READY' || state.document === null || event.requestId <= state.requestId)
        return state;
      return { ...state, phase: 'SAVING', requestId: event.requestId, error: null, notice: null };
    case 'SAVED': {
      if (event.requestId !== state.requestId || state.phase !== 'SAVING') return state;
      const expected = (state.document?.revision ?? 0) + 1;
      if (event.document.revision !== expected)
        return {
          ...state,
          phase: 'RELOAD_REQUIRED',
          // The draft survives: it is the only copy of what was intended.
          error:
            'The server came back with a revision nobody asked for. Reload the saved settings before changing anything else.',
        };
      return accepted(state, event.document, event.notice);
    }
    case 'SAVE_FAILED':
      if (event.requestId !== state.requestId || state.phase !== 'SAVING') return state;
      return {
        ...state,
        phase: event.reloadRequired ? 'RELOAD_REQUIRED' : 'READY',
        error: event.error,
      };
  }
}

function accepted(
  state: EditorState,
  document: RuntimeConfigDocument,
  notice: string | null,
): EditorState {
  return {
    ...state,
    document,
    draft: draftFrom(document),
    phase: 'READY',
    dirty: false,
    error: null,
    notice,
  };
}

// ── history ──────────────────────────────────────────────────────────────────

export interface HistoryState {
  readonly entries: readonly RuntimeConfigHistoryEntry[];
  readonly nextBeforeRevision: number | null;
  readonly requestId: number;
  readonly loading: boolean;
  readonly error: string | null;
}

export const initialHistoryState: HistoryState = {
  entries: [],
  nextBeforeRevision: null,
  requestId: 0,
  loading: true,
  error: null,
};

export type HistoryEvent =
  | { readonly type: 'LOAD'; readonly requestId: number }
  | {
      readonly type: 'LOADED';
      readonly requestId: number;
      readonly beforeRevision?: number;
      readonly history: RuntimeConfigHistory;
    }
  | { readonly type: 'FAILED'; readonly requestId: number };

export function historyReducer(state: HistoryState, event: HistoryEvent): HistoryState {
  if (event.type === 'LOAD')
    return event.requestId > state.requestId
      ? { ...state, requestId: event.requestId, loading: true, error: null }
      : state;
  if (event.requestId !== state.requestId || !state.loading) return state;
  if (event.type === 'FAILED')
    return {
      ...state,
      loading: false,
      error: 'The history could not be read. Try again before restoring anything from it.',
    };
  const entries =
    event.beforeRevision === undefined
      ? [...event.history.entries]
      : [...state.entries, ...event.history.entries];
  // A page that does not continue the one before it is a page we refuse to
  // show: a restore is chosen from this list, and a list assembled out of
  // order would offer the wrong revision.
  const ordered = entries.every(
    (entry, index) => index === 0 || entry.revision < (entries[index - 1]?.revision ?? 0),
  );
  const cursor = event.history.nextBeforeRevision;
  const cursorValid =
    cursor === null || (entries.length > 0 && cursor === entries[entries.length - 1]?.revision);
  const continues =
    event.beforeRevision === undefined || event.beforeRevision === state.nextBeforeRevision;
  if (!ordered || !cursorValid || !continues)
    return {
      ...state,
      loading: false,
      error: 'The history came back inconsistent. Refresh it before restoring a revision.',
    };
  return { ...state, entries, nextBeforeRevision: cursor, loading: false, error: null };
}

// ── what the screen shows about one setting ─────────────────────────────────

/** The value the editor is currently offering for a setting. */
export function draftValue(draft: Draft, setting: RuntimeSetting): RuntimeSettingValue | null {
  const value = draft[setting.name];
  return value === undefined ? null : value;
}

/**
 * What this box would run on if the draft were saved. Not the same as the
 * draft: an environment pin beats anything stored, and the console says so
 * rather than letting someone believe a save will take effect here.
 */
export function wouldRun(
  value: RuntimeSettingValue | null,
  setting: RuntimeSetting,
): { value: RuntimeSettingValue | null; from: 'env' | 'stored' | 'default' } {
  if (setting.pinnedByEnv) return { value: setting.effectiveValue, from: 'env' };
  return value === null
    ? { value: setting.defaultValue, from: 'default' }
    : { value, from: 'stored' };
}

/** Which settings the draft changes, by name — what a save is actually about. */
export function changedSettings(state: EditorState): string[] {
  if (!state.document) return [];
  return state.document.settings
    .filter((setting) => draftValue(state.draft, setting) !== setting.storedValue)
    .map((setting) => setting.name);
}

/** Settings in the order the API sent them, bucketed by group, groups in that same order. */
export function byGroup(settings: readonly RuntimeSetting[]): [string, RuntimeSetting[]][] {
  const groups = new Map<string, RuntimeSetting[]>();
  for (const setting of settings) {
    const bucket = groups.get(setting.group);
    if (bucket) bucket.push(setting);
    else groups.set(setting.group, [setting]);
  }
  return [...groups.entries()];
}
