import { beforeEach, describe, expect, it } from 'vitest';
import { ManualTicker } from '../src/clock.js';
import { BoardExecutor, type BoardWarning } from '../src/executor.js';
import { plainLines } from '../src/highlight.js';
import { Layout, MARGIN, PAGE_STRIDE } from '../src/layout.js';
import { FADE_MS, HAND_CPS, handwritingMs, MAX_STRETCH } from '../src/pacing.js';
import { SHAPE_TYPE, UNDERLINE_UNITS } from '../src/shapes/props.js';
import { boardOp, FakeEditor, flush, loadTestFont } from './helpers.js';

function setup(opts: { camera?: boolean } = {}) {
  const editor = new FakeEditor();
  const ticker = new ManualTicker();
  const warnings: BoardWarning[] = [];
  const dims: boolean[] = [];
  const executor = new BoardExecutor({
    editor,
    ticker,
    layout: new Layout(),
    font: loadTestFont(),
    highlighter: { highlight: async (code) => plainLines(code) },
    ...(opts.camera ? {} : { camera: null }),
    onWarning: (w) => warnings.push(w),
    onDimmed: (d) => dims.push(d),
  });
  return { editor, ticker, executor, warnings, dims };
}

describe('BoardExecutor', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('title: creates an ink-text shape and reveals it at the handwriting pace', async () => {
    const { editor, ticker, executor } = ctx;
    const text = 'Attention';
    const exec = executor.execute(boardOp('b1', { op: 'title', text }), { paceMs: null });
    await flush();
    const shape = editor.shapes.get('shape:b1');
    expect(shape?.type).toBe(SHAPE_TYPE.inkText);
    expect(shape?.props).toMatchObject({ text, style: 'title', underline: true, progress: 0 });
    expect(shape?.x).toBe(MARGIN);
    expect(shape?.y).toBe(MARGIN);
    const natural = handwritingMs(text.length + UNDERLINE_UNITS);
    ticker.advance(natural / 2);
    expect(editor.progress('shape:b1')).toBeCloseTo(0.5, 1);
    ticker.advance(natural);
    await exec.done;
    expect(editor.progress('shape:b1')).toBe(1);
    expect(executor.activeCount).toBe(0);
  });

  it('write: never faster than the human constant, stretched to a long sentence, capped', async () => {
    const { editor, ticker, executor } = ctx;
    const text = 'the cat sat on the mat'; // 22 chars → 2000 ms natural
    // short sentence → natural speed
    const a = executor.execute(boardOp('b1', { op: 'write', text, place: 'newline' }), {
      paceMs: 300,
    });
    await flush();
    ticker.advance(1000);
    expect(editor.progress('shape:b1')).toBeCloseTo(0.5, 1);
    ticker.advance(1100);
    await a.done;
    // long sentence → stretched
    const b = executor.execute(boardOp('b2', { op: 'write', text, place: 'newline' }), {
      paceMs: 4000,
    });
    await flush();
    ticker.advance(2000);
    expect(editor.progress('shape:b2')).toBeCloseTo(0.5, 1);
    ticker.advance(2100);
    await b.done;
    // absurd sentence → capped at MAX_STRETCH × natural
    const c = executor.execute(boardOp('b3', { op: 'write', text, place: 'newline' }), {
      paceMs: 60_000,
    });
    await flush();
    const capped = (text.length / HAND_CPS) * 1000 * MAX_STRETCH;
    ticker.advance(capped + 50);
    await c.done;
    expect(editor.progress('shape:b3')).toBe(1);
  });

  it('flow keeps a short phrase on the same line and wraps a long one', async () => {
    const { editor, executor } = ctx;
    executor.execute(boardOp('b1', { op: 'write', text: 'alpha' }), { paceMs: null }).finish();
    executor.execute(boardOp('b2', { op: 'write', text: 'beta' }), { paceMs: null }).finish();
    await flush();
    const a = editor.shapes.get('shape:b1');
    const b = editor.shapes.get('shape:b2');
    expect(b?.y).toBe(a?.y);
    expect(b?.x).toBeGreaterThan((a?.x ?? 0) + Number(a?.props.w));
    executor
      .execute(
        boardOp('b3', { op: 'write', text: 'a much longer phrase that will not fit on this line' }),
        { paceMs: null },
      )
      .finish();
    await flush();
    const c = editor.shapes.get('shape:b3');
    expect(c?.x).toBe(MARGIN);
    expect(c?.y).toBeGreaterThan(a?.y ?? 0);
  });

  it('pause freezes mid-stroke, resume continues, finish completes, cancel leaves what was drawn', async () => {
    const { editor, ticker, executor } = ctx;
    const text = 'twenty two characters!'; // 2000 ms
    const exec = executor.execute(boardOp('b1', { op: 'write', text }), { paceMs: null });
    await flush();
    ticker.advance(500);
    exec.pause();
    const frozen = editor.progress('shape:b1');
    ticker.advance(5000);
    expect(editor.progress('shape:b1')).toBe(frozen);
    exec.resume();
    ticker.advance(500);
    expect(editor.progress('shape:b1')).toBeCloseTo(0.5, 1);
    exec.finish();
    await exec.done;
    expect(editor.progress('shape:b1')).toBe(1);

    const exec2 = executor.execute(boardOp('b2', { op: 'write', text, place: 'newline' }), {
      paceMs: null,
    });
    await flush();
    ticker.advance(400);
    exec2.cancel();
    await exec2.done;
    const left = editor.progress('shape:b2');
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(1);
    ticker.advance(5000);
    expect(editor.progress('shape:b2')).toBe(left);
    expect(editor.shapes.has('shape:b2')).toBe(true);
  });

  it('control calls before the shapes exist are honoured', async () => {
    const { editor, ticker, executor } = ctx;
    const a = executor.execute(boardOp('b1', { op: 'write', text: 'hello' }), { paceMs: null });
    a.pause();
    await flush();
    ticker.advance(2000);
    expect(editor.progress('shape:b1')).toBe(0);
    a.resume();
    ticker.advance(2000);
    await a.done;
    const b = executor.execute(boardOp('b2', { op: 'write', text: 'hello' }), { paceMs: null });
    b.finish();
    await flush();
    await b.done;
    expect(editor.progress('shape:b2')).toBe(1);
    const c = executor.execute(boardOp('b3', { op: 'write', text: 'hello' }), { paceMs: null });
    c.cancel();
    await flush();
    await c.done;
    expect(editor.shapes.has('shape:b3')).toBe(false);
  });

  it('code: frame stroke first, then typewriter, both stretched to the sentence', async () => {
    const { editor, ticker, executor } = ctx;
    const code = 'let x = 1\nprint(x)';
    const exec = executor.execute(boardOp('b1', { op: 'code', text: code, lang: 'swift' }), {
      paceMs: 4000,
    });
    await flush();
    const frame = editor.shapes.get('shape:b1.frame');
    const block = editor.shapes.get('shape:b1');
    expect(frame?.type).toBe(SHAPE_TYPE.inkStroke);
    expect(frame?.props).toMatchObject({ role: 'frame' });
    expect(block?.type).toBe(SHAPE_TYPE.codeBlock);
    expect(block?.props.lines).toEqual(plainLines(code));
    ticker.advance(200);
    expect(editor.progress('shape:b1.frame')).toBeGreaterThan(0);
    expect(editor.progress('shape:b1')).toBe(0);
    ticker.advance(2000);
    expect(editor.progress('shape:b1.frame')).toBe(1);
    expect(editor.progress('shape:b1')).toBeGreaterThan(0);
    expect(editor.progress('shape:b1')).toBeLessThan(1);
    ticker.advance(2000);
    await exec.done;
    expect(editor.progress('shape:b1')).toBe(1);
  });

  it('markdown: one md-block sized from the estimate', async () => {
    const { editor, executor } = ctx;
    executor
      .execute(boardOp('b1', { op: 'markdown', text: '# Hi\n- one\n- two' }), { paceMs: null })
      .finish();
    await flush();
    const s = editor.shapes.get('shape:b1');
    expect(s?.type).toBe(SHAPE_TYPE.mdBlock);
    expect(Number(s?.props.h)).toBeGreaterThan(60);
    expect(Number(s?.props.w)).toBe(640);
  });

  it('sketch: boxes, labels and arrows in order; nodes become refs', async () => {
    const { editor, ticker, executor } = ctx;
    const src = 'box q "Query"\nbox k "Key"\nrow\nbox s "Score"\narrow q s\narrow k s "w"';
    const exec = executor.execute(boardOp('b1', { op: 'sketch', text: src, place: 'center' }), {
      paceMs: null,
    });
    await flush();
    expect(editor.ofType(SHAPE_TYPE.inkStroke)).toHaveLength(3 + 2);
    expect(editor.ofType(SHAPE_TYPE.inkText)).toHaveLength(3 + 1);
    expect(executor.hasRef('q')).toBe(true);
    expect(executor.hasRef('b1.s')).toBe(true);
    expect(executor.hasRef('b1')).toBe(true);
    // Sequential reveal: the first box draws before its label, and before the second box.
    ticker.advance(100);
    expect(editor.progress('shape:b1.q.s')).toBeGreaterThan(0);
    expect(editor.progress('shape:b1.q.t')).toBe(0);
    expect(editor.progress('shape:b1.k.s')).toBe(0);
    exec.finish();
    await exec.done;
    for (const s of editor.shapes.values()) expect(Number(s.props.progress)).toBe(1);
    const q = executor.boundsOf('q');
    const s = executor.boundsOf('s');
    if (!q || !s) throw new Error('bounds missing');
    expect(s.y).toBeGreaterThan(q.y + q.h);
  });

  it('sketch with no parsable nodes falls back to handwriting and warns', async () => {
    const { editor, executor, warnings } = ctx;
    executor
      .execute(boardOp('b1', { op: 'sketch', text: 'just some prose' }), { paceMs: null })
      .finish();
    await flush();
    expect(editor.shapes.get('shape:b1')?.type).toBe(SHAPE_TYPE.inkText);
    expect(warnings.some((w) => w.code === 'sketch-parse')).toBe(true);
  });

  it('highlight: rings a short ref, underlines a wide one, warns on unknown refs', async () => {
    const { editor, executor, warnings } = ctx;
    executor.execute(boardOp('b1', { op: 'write', text: 'cat' }), { paceMs: null }).finish();
    executor.execute(boardOp('b2', { op: 'highlight', ref: 'b1' }), { paceMs: null }).finish();
    await flush();
    const ring = editor.shapes.get('shape:b2');
    expect(ring?.props).toMatchObject({ role: 'highlight', emphasis: 'accent' });
    const target = editor.getShapePageBounds('shape:b1');
    if (!target || !ring) throw new Error('missing');
    expect(ring.x).toBeLessThan(target.x);
    expect(ring.y).toBeLessThan(target.y);

    executor
      .execute(
        boardOp('b3', {
          op: 'write',
          text: 'a very wide phrase to underline here',
          place: 'newline',
        }),
        { paceMs: null },
      )
      .finish();
    executor.execute(boardOp('b4', { op: 'highlight', ref: 'b3' }), { paceMs: null }).finish();
    await flush();
    const under = editor.shapes.get('shape:b4');
    const wide = editor.getShapePageBounds('shape:b3');
    if (!under || !wide) throw new Error('missing');
    expect(under.y).toBeGreaterThan(wide.y + wide.h * 0.8);

    const bad = executor.execute(boardOp('b5', { op: 'highlight', ref: 'zzz' }), { paceMs: null });
    await flush();
    await bad.done;
    expect(editor.shapes.has('shape:b5')).toBe(false);
    expect(warnings.some((w) => w.code === 'unknown-ref' && w.opId === 'b5')).toBe(true);
  });

  it('arrow: connects two refs with an optional label', async () => {
    const { editor, executor } = ctx;
    executor.execute(boardOp('b1', { op: 'write', text: 'A' }), { paceMs: null }).finish();
    executor
      .execute(boardOp('b2', { op: 'write', text: 'B', place: 'column' }), { paceMs: null })
      .finish();
    executor
      .execute(boardOp('b3', { op: 'arrow', ref: 'b1', ref2: 'b2', text: 'maps to' }), {
        paceMs: null,
      })
      .finish();
    await flush();
    const arrow = editor.shapes.get('shape:b3');
    const label = editor.shapes.get('shape:b3.t');
    expect(arrow?.props).toMatchObject({ role: 'arrow' });
    expect(label?.props).toMatchObject({ text: 'maps to', style: 'label' });
    const a = editor.getShapePageBounds('shape:b1');
    const b = editor.getShapePageBounds('shape:b2');
    if (!a || !b || !arrow) throw new Error('missing');
    expect(arrow.x).toBeGreaterThanOrEqual(a.x + a.w - 20);
    expect(arrow.x + Number(arrow.props.w)).toBeLessThanOrEqual(b.x + 20);
  });

  it('erase: fades a ref then deletes it; erase all clears the paper and restarts the page', async () => {
    const { editor, ticker, executor } = ctx;
    executor.execute(boardOp('b1', { op: 'write', text: 'one' }), { paceMs: null }).finish();
    executor.execute(boardOp('b2', { op: 'write', text: 'two' }), { paceMs: null }).finish();
    await flush();
    const e = executor.execute(boardOp('b3', { op: 'erase', ref: 'b1' }), { paceMs: 5000 });
    await flush();
    ticker.advance(FADE_MS / 2);
    expect(editor.shapes.get('shape:b1')?.opacity).toBeCloseTo(0.5, 1);
    ticker.advance(FADE_MS);
    await e.done;
    expect(editor.shapes.has('shape:b1')).toBe(false);
    expect(executor.hasRef('b1')).toBe(false);
    expect(editor.shapes.has('shape:b2')).toBe(true);

    // Cancelling an erase still removes the half-faded ink.
    const e2 = executor.execute(boardOp('b4', { op: 'erase', ref: 'b2' }), { paceMs: null });
    await flush();
    ticker.advance(100);
    e2.cancel();
    await e2.done;
    expect(editor.shapes.has('shape:b2')).toBe(false);

    executor
      .execute(boardOp('b5', { op: 'write', text: 'three', place: 'newline' }), { paceMs: null })
      .finish();
    executor.execute(boardOp('b6', { op: 'erase', ref: 'all' }), { paceMs: null }).finish();
    await flush();
    expect(editor.shapes.size).toBe(0);
    executor.execute(boardOp('b7', { op: 'write', text: 'fresh' }), { paceMs: null }).finish();
    await flush();
    expect(editor.shapes.get('shape:b7')?.y).toBe(MARGIN);
  });

  it('newpage moves the layout down and frames the new page', async () => {
    const editorCtx = setup({ camera: true });
    const { editor, ticker, executor } = editorCtx;
    executor.execute(boardOp('b1', { op: 'write', text: 'old' }), { paceMs: null }).finish();
    await flush();
    const np = executor.execute(boardOp('b2', { op: 'newpage' }), { paceMs: null });
    await flush();
    expect(editor.cameraMoves.at(-1)?.bounds.y).toBe(PAGE_STRIDE);
    ticker.advance(600);
    await np.done;
    executor.execute(boardOp('b3', { op: 'write', text: 'new' }), { paceMs: null }).finish();
    await flush();
    expect(editor.shapes.get('shape:b3')?.y).toBe(PAGE_STRIDE + MARGIN);
    expect(editor.shapes.has('shape:b1')).toBe(true);
  });

  it('camera follows content that leaves the viewport, within the zoom limits', async () => {
    const { editor, executor } = setup({ camera: true });
    editor.viewport = { x: 0, y: 0, w: 800, h: 500 };
    editor.zoom = 1;
    executor.execute(boardOp('b1', { op: 'write', text: 'in view' }), { paceMs: null }).finish();
    await flush();
    expect(editor.cameraMoves).toHaveLength(0);
    executor
      .execute(boardOp('b2', { op: 'write', text: 'far away', place: 'column' }), { paceMs: null })
      .finish();
    await flush();
    expect(editor.cameraMoves).toHaveLength(1);
    const move = editor.cameraMoves[0];
    expect(move?.opts.animation?.duration).toBe(550);
    expect(move?.opts.force).toBe(true);
    expect(move?.opts.targetZoom).toBeGreaterThanOrEqual(0.6);
    expect(move?.opts.targetZoom).toBeLessThanOrEqual(1.2);
  });

  it('pinNote places a card in the right column and stacks a second one', async () => {
    const { editor, executor } = ctx;
    executor.pinNote(
      { type: 'note', question: 'why √d?', headline: 'Scale', detail: 'keeps softmax soft' },
      'n1',
    );
    executor.pinNote({ type: 'note', question: 'second', headline: '', detail: '' }, 'n2');
    const a = editor.shapes.get('shape:note.n1');
    const b = editor.shapes.get('shape:note.n2');
    expect(a?.type).toBe(SHAPE_TYPE.noteCard);
    expect(a?.x).toBe(1600 - MARGIN - 300);
    expect(b?.y).toBeGreaterThan((a?.y ?? 0) + Number(a?.props.h));
    expect(a?.props).toMatchObject({ question: 'why √d?', label: 'Scale' });
  });

  it('setDimmed reports transitions once; clear removes everything and resets', async () => {
    const { editor, executor, dims } = ctx;
    executor.setDimmed(true);
    executor.setDimmed(true);
    executor.setDimmed(false);
    expect(dims).toEqual([true, false]);
    executor.execute(boardOp('b1', { op: 'write', text: 'x' }), { paceMs: null }).finish();
    executor.pinNote({ type: 'note', question: 'q', headline: '', detail: '' }, 'n1');
    await flush();
    const running = executor.execute(
      boardOp('b2', { op: 'write', text: 'slow words here', place: 'newline' }),
      {
        paceMs: null,
      },
    );
    await flush();
    executor.clear();
    await running.done;
    expect(editor.shapes.size).toBe(0);
    expect(executor.hasRef('b1')).toBe(false);
    executor.execute(boardOp('b3', { op: 'write', text: 'again' }), { paceMs: null }).finish();
    await flush();
    expect(editor.shapes.get('shape:b3')).toMatchObject({ x: MARGIN, y: MARGIN });
  });

  it('a replaced take (same id) replaces the earlier shapes', async () => {
    const { editor, executor } = ctx;
    executor.execute(boardOp('b1', { op: 'write', text: 'first' }), { paceMs: null }).finish();
    await flush();
    executor.execute(boardOp('b1', { op: 'write', text: 'second' }), { paceMs: null }).finish();
    await flush();
    expect(editor.shapes.size).toBe(1);
    expect(editor.shapes.get('shape:b1')?.props.text).toBe('second');
  });

  it('empty text warns and resolves without drawing', async () => {
    const { editor, executor, warnings } = ctx;
    const e = executor.execute(boardOp('b1', { op: 'write', text: '   ' }), { paceMs: null });
    await flush();
    await e.done;
    expect(editor.shapes.size).toBe(0);
    expect(warnings[0]?.code).toBe('empty-text');
  });

  it('a font that never arrives falls back after the timeout instead of stalling', async () => {
    const editor = new FakeEditor();
    const ticker = new ManualTicker();
    const warnings: BoardWarning[] = [];
    const executor = new BoardExecutor({
      editor,
      ticker,
      camera: null,
      font: () => new Promise(() => {}),
      fontTimeoutMs: 20,
      highlighter: { highlight: async (code) => plainLines(code) },
      onWarning: (w) => warnings.push(w),
    });
    const e = executor.execute(boardOp('b1', { op: 'write', text: 'hello' }), { paceMs: null });
    e.finish();
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    await e.done;
    expect(editor.shapes.get('shape:b1')?.props.text).toBe('hello');
    expect(warnings.some((w) => w.code === 'font-unavailable')).toBe(true);
  });

  it('a glyph source with broken path data is sanitised and reported as glyph-path', async () => {
    const editor = new FakeEditor();
    const ticker = new ManualTicker();
    const warnings: BoardWarning[] = [];
    const real = loadTestFont();
    const executor = new BoardExecutor({
      editor,
      ticker,
      camera: null,
      font: {
        ascent: real.ascent,
        descent: real.descent,
        has: (ch) => real.has(ch),
        advance: (ch, size) => real.advance(ch, size),
        kerning: (a, b, size) => real.kerning(a, b, size),
        path: (ch, x, y, size) =>
          ch === 'e' ? `M${x} ${y}QNaN 1 2 3L${x + 4} ${y}` : real.path(ch, x, y, size),
      },
      highlighter: { highlight: async (code) => plainLines(code) },
      onWarning: (w) => warnings.push(w),
    });
    const e = executor.execute(boardOp('b1', { op: 'write', text: 'sees' }), { paceMs: null });
    e.finish();
    await flush();
    await e.done;
    expect(editor.shapes.get('shape:b1')?.props.text).toBe('sees');
    const w = warnings.find((x) => x.code === 'glyph-path');
    expect(w?.opId).toBe('b1');
    expect(w?.message).toContain('"e"');
  });

  it('after dispose, execute resolves immediately and draws nothing', async () => {
    const { editor, executor } = ctx;
    executor.dispose();
    const e = executor.execute(boardOp('b1', { op: 'write', text: 'x' }), { paceMs: null });
    await e.done;
    expect(editor.shapes.size).toBe(0);
  });
});
