import type {
  RuntimeConfigDocument,
  RuntimeConfigHistoryEntry,
  RuntimeSetting,
} from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import {
  changedSettings,
  draftFrom,
  draftValue,
  type EditorState,
  editorReducer,
  historyReducer,
  initialEditorState,
  initialHistoryState,
  wouldRun,
} from '../src/lib/runtime-config-state.js';

/**
 * The editor's rules under concurrency (ADR-0026). Nothing renders here: the
 * point of keeping the state machine out of the hook is that a late response,
 * a lost race and a skipped revision are all testable as plain functions.
 */

function setting(over: Partial<RuntimeSetting> = {}): RuntimeSetting {
  return {
    name: 'PEN_THUMBNAIL_QUALITY',
    env: 'PEN_THUMBNAIL_QUALITY',
    label: 'Picture quality',
    description: 'How good a session card looks.',
    group: 'Session cards',
    kind: 'choice',
    scope: 'session',
    options: ['low', 'medium', 'high'],
    defaultValue: 'low',
    storedValue: null,
    effectiveValue: 'low',
    source: 'default',
    pinnedByEnv: false,
    ...over,
  };
}

function document(over: Partial<RuntimeConfigDocument> = {}): RuntimeConfigDocument {
  return {
    revision: 4,
    updatedAt: 1_700_000_000_000,
    updatedBy: 'p_admin',
    updatedByName: 'Sam Owner',
    settings: [setting()],
    stale: false,
    ...over,
  };
}

/** A loaded, editable editor at the given document. */
function ready(doc = document()): EditorState {
  const loading = editorReducer(initialEditorState, { type: 'LOAD', requestId: 1 });
  return editorReducer(loading, { type: 'LOADED', requestId: 1, document: doc });
}

describe('loading', () => {
  it('arrives with a draft that is exactly what is stored, inventing nothing', () => {
    const state = ready(document({ settings: [setting({ storedValue: 'high' })] }));
    expect(state.phase).toBe('READY');
    expect(state.draft).toEqual({ PEN_THUMBNAIL_QUALITY: 'high' });
    expect(state.dirty).toBe(false);
  });

  it('ignores a response that a newer request has already overtaken', () => {
    const state = ready();
    const reloading = editorReducer(state, { type: 'LOAD', requestId: 2 });
    // The first read finally answers, with what is now old news.
    const late = editorReducer(reloading, {
      type: 'LOADED',
      requestId: 1,
      document: document({ revision: 1 }),
    });
    expect(late).toBe(reloading);
  });

  it('will not start a read while a save is in flight', () => {
    const saving = editorReducer(ready(), { type: 'SAVE', requestId: 2 });
    expect(editorReducer(saving, { type: 'LOAD', requestId: 3 })).toBe(saving);
  });
});

describe('editing', () => {
  it('marks the draft dirty and reports which settings a save would change', () => {
    const state = editorReducer(ready(), {
      type: 'EDIT',
      draft: { PEN_THUMBNAIL_QUALITY: 'high' },
    });
    expect(state.dirty).toBe(true);
    expect(changedSettings(state)).toEqual(['PEN_THUMBNAIL_QUALITY']);
  });

  it('refuses edits while a save is in flight, so the request and the draft cannot diverge', () => {
    const saving = editorReducer(ready(), { type: 'SAVE', requestId: 2 });
    expect(editorReducer(saving, { type: 'EDIT', draft: { X: 1 } })).toBe(saving);
  });
});

describe('saving', () => {
  it('accepts exactly the next revision and rebases the draft onto it', () => {
    const saving = editorReducer(ready(), { type: 'SAVE', requestId: 2 });
    const saved = editorReducer(saving, {
      type: 'SAVED',
      requestId: 2,
      document: document({ revision: 5, settings: [setting({ storedValue: 'high' })] }),
      notice: 'Saved as revision 5.',
    });
    expect(saved.phase).toBe('READY');
    expect(saved.dirty).toBe(false);
    expect(saved.draft).toEqual({ PEN_THUMBNAIL_QUALITY: 'high' });
    expect(saved.notice).toBe('Saved as revision 5.');
  });

  it('treats a revision that skipped a number as a reason to reload, and keeps the draft', () => {
    const edited = editorReducer(ready(), {
      type: 'EDIT',
      draft: { PEN_THUMBNAIL_QUALITY: 'medium' },
    });
    const saving = editorReducer(edited, { type: 'SAVE', requestId: 2 });
    const surprised = editorReducer(saving, {
      type: 'SAVED',
      requestId: 2,
      document: document({ revision: 9 }),
      notice: 'Saved as revision 9.',
    });
    expect(surprised.phase).toBe('RELOAD_REQUIRED');
    // The draft is the only copy of what was intended; it is not thrown away.
    expect(surprised.draft).toEqual({ PEN_THUMBNAIL_QUALITY: 'medium' });
  });

  it('keeps the draft on a conflict and demands a reload before the next attempt', () => {
    const edited = editorReducer(ready(), {
      type: 'EDIT',
      draft: { PEN_THUMBNAIL_QUALITY: 'medium' },
    });
    const saving = editorReducer(edited, { type: 'SAVE', requestId: 2 });
    const failed = editorReducer(saving, {
      type: 'SAVE_FAILED',
      requestId: 2,
      error: 'Someone else saved first.',
      reloadRequired: true,
    });
    expect(failed.phase).toBe('RELOAD_REQUIRED');
    expect(failed.draft).toEqual({ PEN_THUMBNAIL_QUALITY: 'medium' });
    expect(failed.dirty).toBe(true);
    // And nothing further may be saved from here.
    expect(editorReducer(failed, { type: 'SAVE', requestId: 3 })).toBe(failed);
  });

  it('stays editable after a refusal the operator can fix in place', () => {
    const saving = editorReducer(ready(), { type: 'SAVE', requestId: 2 });
    const failed = editorReducer(saving, {
      type: 'SAVE_FAILED',
      requestId: 2,
      error: 'Picture quality: must be one of low, medium, high.',
      reloadRequired: false,
    });
    expect(failed.phase).toBe('READY');
    expect(failed.error).toContain('Picture quality');
  });
});

describe('what would actually run', () => {
  it('says the default when a setting has no override', () => {
    const doc = document();
    const state = ready(doc);
    expect(
      wouldRun(
        draftValue(state.draft, doc.settings[0] as RuntimeSetting),
        doc.settings[0] as RuntimeSetting,
      ),
    ).toEqual({
      value: 'low',
      from: 'default',
    });
  });

  it('says the environment wins on a pinned setting, whatever the draft says', () => {
    const pinned = setting({
      pinnedByEnv: true,
      effectiveValue: 'medium',
      source: 'env',
      storedValue: 'high',
    });
    const state = ready(document({ settings: [pinned] }));
    const edited = editorReducer(state, { type: 'EDIT', draft: { PEN_THUMBNAIL_QUALITY: 'low' } });
    expect(wouldRun(draftValue(edited.draft, pinned), pinned)).toEqual({
      value: 'medium',
      from: 'env',
    });
  });
});

describe('history', () => {
  const entry = (revision: number): RuntimeConfigHistoryEntry => ({
    revision,
    updatedAt: 1_700_000_000_000 + revision,
    updatedBy: 'p_admin',
    updatedByName: 'Sam Owner',
    reason: `change ${revision}`,
    restoredFromRevision: null,
    settings: {},
  });

  it('takes a first page and remembers where the next one starts', () => {
    const loading = historyReducer(initialHistoryState, { type: 'LOAD', requestId: 1 });
    const loaded = historyReducer(loading, {
      type: 'LOADED',
      requestId: 1,
      history: { entries: [entry(4), entry(3)], nextBeforeRevision: 3 },
    });
    expect(loaded.entries.map((e) => e.revision)).toEqual([4, 3]);
    expect(loaded.nextBeforeRevision).toBe(3);
  });

  it('appends a page that continues the one before it', () => {
    const first = historyReducer(
      historyReducer(initialHistoryState, { type: 'LOAD', requestId: 1 }),
      {
        type: 'LOADED',
        requestId: 1,
        history: { entries: [entry(4), entry(3)], nextBeforeRevision: 3 },
      },
    );
    const second = historyReducer(historyReducer(first, { type: 'LOAD', requestId: 2 }), {
      type: 'LOADED',
      requestId: 2,
      beforeRevision: 3,
      history: { entries: [entry(2), entry(1)], nextBeforeRevision: null },
    });
    expect(second.entries.map((e) => e.revision)).toEqual([4, 3, 2, 1]);
    expect(second.nextBeforeRevision).toBeNull();
  });

  it('refuses a page that does not follow the last one, rather than offering the wrong revision to restore', () => {
    const first = historyReducer(
      historyReducer(initialHistoryState, { type: 'LOAD', requestId: 1 }),
      {
        type: 'LOADED',
        requestId: 1,
        history: { entries: [entry(4), entry(3)], nextBeforeRevision: 3 },
      },
    );
    const wrong = historyReducer(historyReducer(first, { type: 'LOAD', requestId: 2 }), {
      type: 'LOADED',
      requestId: 2,
      beforeRevision: 3,
      // Out of order: 5 cannot come after 3.
      history: { entries: [entry(5)], nextBeforeRevision: null },
    });
    expect(wrong.error).toContain('inconsistent');
    expect(wrong.entries.map((e) => e.revision)).toEqual([4, 3]);
  });
});

describe('draftFrom', () => {
  it('covers every setting the document names, and only those', () => {
    const doc = document({
      settings: [
        setting({ storedValue: 'high' }),
        setting({
          name: 'PEN_TTS_CACHE_MB',
          env: 'PEN_TTS_CACHE_MB',
          kind: 'number',
          defaultValue: 2048,
          effectiveValue: 2048,
        }),
      ],
    });
    expect(draftFrom(doc)).toEqual({ PEN_THUMBNAIL_QUALITY: 'high', PEN_TTS_CACHE_MB: null });
  });
});
