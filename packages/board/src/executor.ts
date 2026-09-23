import type { BoardExecuteOptions, BoardExecution, BoardPort } from '@pen/conductor';
import type { BoardEvent, Emphasis, NoteEvent, Placement } from '@pen/contracts';
import { CameraDirector } from './camera.js';
import { AnimationClock, createRafTicker, type Ticker } from './clock.js';
import {
  type EditorLike,
  type ShapeRecordInit,
  type ShapeRecordUpdate,
  toShapeId,
} from './editor-like.js';
import { FallbackFont, type GlyphSource, whenHandFont } from './font.js';
import { type Bounds, bottom, type Point, union } from './geometry.js';
import { type HandTextLayout, layoutHandText, measureHandText } from './glyphs.js';
import { type CodeHighlighter, createShikiHighlighter } from './highlight.js';
import { Layout } from './layout.js';
import { estimateMarkdownLines, markdownCharCount, parseMarkdown } from './markdown.js';
import {
  CAMERA_MS,
  FADE_MS,
  handwritingMs,
  penTravelMs,
  resolvePace,
  typewriterMs,
} from './pacing.js';
import {
  handArrow,
  handEllipse,
  handRect,
  handRoundedRect,
  handUnderline,
  normaliseStrokes,
  type Stroke,
  strokesLength,
} from './primitives.js';
import {
  CODE_PADDING,
  type CodeBlockProps,
  FRAME_INSET,
  type InkStrokeProps,
  type InkTextProps,
  type InkTextStyle,
  inkTextUnits,
  MD_PADDING,
  type MdBlockProps,
  NOTE_PADDING,
  NOTE_WIDTH,
  type NoteCardProps,
  SHAPE_TYPE,
  STROKE_STYLE,
  type StrokeRole,
  TYPE,
} from './shapes/props.js';
import {
  connectNearestSides,
  HAND_ADVANCE_RATIO,
  layoutSketch,
  parseSketch,
  type SketchLayout,
} from './sketch.js';
import { fadeTrack, progressTrack, Timeline } from './timeline.js';

/**
 * BoardExecutor: the `BoardPort` implementation. Each `execute()` maps one
 * board op to shapes plus a Timeline, then drives it with an AnimationClock
 * that the conductor can pause/resume/finish/cancel (ADR-0002: audio is the
 * master clock; the board only ever follows).
 *
 * Preparation is asynchronous (font, highlighter) but serialised through a
 * queue so layout decisions happen in cue order even when the conductor
 * starts several ops back to back. `execute()` itself is synchronous and
 * never throws: a broken op is reported through `onWarning` and its `done`
 * resolves, so a bad cue can never stall a lesson.
 */

export type BoardWarningCode =
  | 'empty-text'
  | 'unknown-ref'
  | 'sketch-parse'
  | 'font-unavailable'
  | 'glyph-path'
  | 'op-failed';

export interface BoardWarning {
  code: BoardWarningCode;
  message: string;
  opId?: string;
}

export interface BoardExecutorOptions {
  editor: EditorLike;
  ticker?: Ticker;
  layout?: Layout;
  /** Glyph source; defaults to the module font registry with a fallback after `fontTimeoutMs`. */
  font?: GlyphSource | (() => Promise<GlyphSource>);
  fontTimeoutMs?: number;
  highlighter?: CodeHighlighter;
  /** Pass `null` to disable camera moves (tests, exports). */
  camera?: CameraDirector | null;
  /** DOM-backed measurement for markdown blocks; falls back to an estimate. */
  measureMarkdown?: (source: string, width: number, fontSize: number) => number | null;
  onWarning?: (warning: BoardWarning) => void;
  onDimmed?: (dimmed: boolean) => void;
}

interface RegistryEntry {
  ids: string[];
  bounds: Bounds;
}

interface Prepared {
  shapes: ShapeRecordInit[];
  timeline: Timeline;
  /** Page bounds of everything created (camera target). */
  bounds: Bounds | null;
  /** Refs to register once the shapes exist. */
  register: Array<{ ref: string; ids: string[]; bounds: Bounds }>;
  /** Runs when the op settles, finished or cancelled (e.g. erase deletes). */
  onSettled?: (reason: 'finished' | 'cancelled') => void;
  /** Camera framing for ops that create nothing (newpage). */
  showPage?: Bounds;
}

const EMPTY: Prepared = { shapes: [], timeline: new Timeline(), bounds: null, register: [] };

/** One in-flight op. Control calls before the clock exists are remembered. */
class Execution implements BoardExecution {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private clock: AnimationClock | null = null;
  private wantPause = false;
  private wantFinish = false;
  private wantCancel = false;
  private settled = false;

  constructor(readonly opId: string) {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get cancelled(): boolean {
    return this.wantCancel;
  }
  get finishRequested(): boolean {
    return this.wantFinish;
  }
  get pauseRequested(): boolean {
    return this.wantPause;
  }

  attach(clock: AnimationClock): void {
    this.clock = clock;
  }

  pause(): void {
    if (this.clock) this.clock.pause();
    else this.wantPause = true;
  }

  resume(): void {
    if (this.clock) this.clock.resume();
    else this.wantPause = false;
  }

  finish(): void {
    if (this.clock) this.clock.finish();
    else this.wantFinish = true;
  }

  cancel(): void {
    if (this.clock) this.clock.cancel();
    else {
      this.wantCancel = true;
    }
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDone();
  }
}

export class BoardExecutor implements BoardPort {
  readonly layout: Layout;
  readonly camera: CameraDirector | null;
  private readonly editor: EditorLike;
  private readonly ticker: Ticker;
  private readonly highlighter: CodeHighlighter;
  private readonly fontSource: () => Promise<GlyphSource>;
  private readonly fontTimeoutMs: number;
  private readonly measureMarkdown: BoardExecutorOptions['measureMarkdown'];
  private readonly onWarning: (w: BoardWarning) => void;
  private readonly onDimmed: (d: boolean) => void;
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly typeById = new Map<string, string>();
  private readonly active = new Set<Execution>();
  private recent: Bounds[] = [];
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private dimmed = false;

  constructor(opts: BoardExecutorOptions) {
    this.editor = opts.editor;
    this.ticker = opts.ticker ?? createRafTicker();
    this.layout = opts.layout ?? new Layout();
    this.highlighter = opts.highlighter ?? createShikiHighlighter();
    this.camera = opts.camera === undefined ? new CameraDirector(opts.editor) : opts.camera;
    this.fontTimeoutMs = opts.fontTimeoutMs ?? 8000;
    const font = opts.font;
    this.fontSource =
      font === undefined
        ? () => whenHandFont()
        : typeof font === 'function'
          ? font
          : () => Promise.resolve(font);
    this.measureMarkdown = opts.measureMarkdown;
    this.onWarning = opts.onWarning ?? ((w) => console.warn(`[board] ${w.code}: ${w.message}`));
    this.onDimmed = opts.onDimmed ?? (() => {});
  }

  // ── BoardPort ─────────────────────────────────────────────────────────

  execute(op: BoardEvent, opts: BoardExecuteOptions): BoardExecution {
    const exec = new Execution(op.id);
    if (this.disposed) {
      exec.settle();
      return exec;
    }
    this.active.add(exec);
    const paceMs = opts.paceMs !== null && Number.isFinite(opts.paceMs) ? opts.paceMs : null;
    const rate =
      opts.rate !== undefined && Number.isFinite(opts.rate) && opts.rate > 0 ? opts.rate : 1;
    this.queue = this.queue
      .then(async () => {
        if (exec.cancelled || this.disposed) return EMPTY;
        // A replaced take (same id) must not leave two copies on the paper.
        this.removeRef(op.id);
        return this.prepare(op, paceMs, rate);
      })
      .catch((err: unknown) => {
        this.warn('op-failed', `${op.op} failed: ${errorMessage(err)}`, op.id);
        return EMPTY;
      })
      .then((prepared) => this.launch(exec, prepared));
    return exec;
  }

  pinNote(note: NoteEvent, id: string): void {
    if (this.disposed) return;
    const ref = `note:${id}`;
    this.removeRef(ref);
    const w = NOTE_WIDTH;
    const inner = w - NOTE_PADDING * 2;
    const questionLines = Math.max(
      1,
      // The hand's own advance ratio, not a Caveat-shaped 0.42 (see sketch.ts).
      Math.ceil((note.question.length * TYPE.labelFont * HAND_ADVANCE_RATIO) / inner),
    );
    const detailLines = note.detail
      ? Math.max(1, Math.ceil((note.detail.length * 14 * 0.5) / inner))
      : 0;
    const h = Math.round(
      NOTE_PADDING * 2 +
        16 +
        10 +
        questionLines * TYPE.labelFont * 1.15 +
        (detailLines ? 8 + detailLines * 20 : 0),
    );
    const slot = this.layout.noteSlot(w, h);
    const sid = toShapeId(`note.${id}`);
    const props: NoteCardProps = {
      label: note.headline || 'You asked',
      question: note.question,
      detail: note.detail,
      lang: note.language,
      w,
      h,
    };
    this.createAll([
      { id: sid, type: SHAPE_TYPE.noteCard, x: slot.x, y: slot.y, props: { ...props } },
    ]);
    this.registry.set(ref, { ids: [sid], bounds: slot });
    this.camera?.follow(slot, this.recent);
  }

  setDimmed(dimmed: boolean): void {
    if (this.dimmed === dimmed) return;
    this.dimmed = dimmed;
    this.onDimmed(dimmed);
  }

  clear(): void {
    for (const exec of this.active) exec.cancel();
    const ids = [...this.registry.values()].flatMap((e) => e.ids);
    if (ids.length) this.editor.run(() => this.editor.deleteShapes(ids), { history: 'ignore' });
    for (const id of ids) this.typeById.delete(id);
    this.registry.clear();
    this.recent = [];
    this.layout.reset();
    this.camera?.showPage(this.layout.pageArea, false);
  }

  dispose(): void {
    this.disposed = true;
    for (const exec of this.active) exec.cancel();
    this.active.clear();
  }

  // ── introspection (tests, debugging) ──────────────────────────────────

  get activeCount(): number {
    return this.active.size;
  }

  boundsOf(ref: string): Bounds | undefined {
    const entry = this.registry.get(ref);
    if (!entry) return undefined;
    const live = entry.ids
      .map((id) => this.editor.getShapePageBounds(id))
      .filter((b): b is Bounds => Boolean(b));
    return union(live) ?? entry.bounds;
  }

  hasRef(ref: string): boolean {
    return this.registry.has(ref);
  }

  /** Every shape id the executor owns (for snapshots). */
  shapeIds(): string[] {
    return [...this.registry.values()].flatMap((e) => e.ids);
  }

  // ── running ───────────────────────────────────────────────────────────

  private launch(exec: Execution, prepared: Prepared): void {
    if (this.disposed) {
      this.active.delete(exec);
      exec.settle();
      return;
    }
    if (exec.cancelled) {
      this.active.delete(exec);
      exec.settle();
      return;
    }

    if (prepared.shapes.length) {
      this.createAll(prepared.shapes);
      for (const r of prepared.register) this.registry.set(r.ref, { ids: r.ids, bounds: r.bounds });
      if (prepared.bounds) {
        this.camera?.follow(prepared.bounds, this.recent);
        this.remember(prepared.bounds);
      }
    } else if (prepared.showPage) {
      this.recent = [];
      this.camera?.showPage(prepared.showPage);
    }

    const timeline = prepared.timeline;
    const durationMs = prepared.showPage ? CAMERA_MS : timeline.totalMs;
    const clock = new AnimationClock({
      ticker: this.ticker,
      durationMs,
      onFrame: (elapsed) => this.apply(timeline.sample(elapsed)),
      onSettled: (reason) => {
        if (reason === 'finished') this.apply(timeline.finalUpdates());
        prepared.onSettled?.(reason);
        this.active.delete(exec);
        exec.settle();
      },
    });
    exec.attach(clock);
    if (exec.finishRequested) {
      clock.start();
      clock.finish();
      return;
    }
    clock.start();
    if (exec.pauseRequested) clock.pause();
  }

  private apply(updates: ReturnType<Timeline['sample']>): void {
    if (!updates.length) return;
    const records: ShapeRecordUpdate[] = [];
    for (const u of updates) {
      const type = this.typeById.get(u.id);
      if (!type) continue; // deleted meanwhile (clear/erase)
      const rec: ShapeRecordUpdate = { id: u.id, type };
      if (u.props) rec.props = u.props;
      if (u.opacity !== undefined) rec.opacity = u.opacity;
      records.push(rec);
    }
    if (records.length)
      this.editor.run(() => this.editor.updateShapes(records), { history: 'ignore' });
  }

  private createAll(shapes: ShapeRecordInit[]): void {
    for (const s of shapes) this.typeById.set(s.id, s.type);
    this.editor.run(() => this.editor.createShapes(shapes), { history: 'ignore' });
  }

  private removeRef(ref: string): void {
    const entry = this.registry.get(ref);
    if (!entry) return;
    this.registry.delete(ref);
    // Sketch nodes registered under the op share its shapes; drop them too.
    for (const [key, other] of this.registry) {
      if (other.ids.some((id) => entry.ids.includes(id))) this.registry.delete(key);
    }
    this.editor.run(() => this.editor.deleteShapes(entry.ids), { history: 'ignore' });
    for (const id of entry.ids) this.typeById.delete(id);
  }

  private remember(b: Bounds): void {
    const page = this.layout.pageArea;
    // Context only makes sense on the same page area.
    this.recent = [
      ...this.recent.filter((r) => r.y >= page.y && bottom(r) <= bottom(page)),
      b,
    ].slice(-3);
  }

  /** A glyph path carried a non-finite coordinate: it was sanitised, but the font deserves a look. */
  private reportInvalidGlyphs(tl: HandTextLayout, opId: string): void {
    if (tl.invalidGlyphs.length === 0) return;
    const chars = [...new Set(tl.invalidGlyphs)].map((c) => JSON.stringify(c)).join(' ');
    this.warn('glyph-path', `non-finite glyph path coordinates sanitised for ${chars}`, opId);
  }

  private warn(code: BoardWarningCode, message: string, opId?: string): void {
    const w: BoardWarning = opId === undefined ? { code, message } : { code, message, opId };
    this.onWarning(w);
  }

  private async font(opId: string): Promise<GlyphSource> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<GlyphSource>((resolve) => {
      timer = setTimeout(() => {
        this.warn(
          'font-unavailable',
          'hand font not loaded in time; using CSS fallback metrics',
          opId,
        );
        resolve(new FallbackFont());
      }, this.fontTimeoutMs);
    });
    try {
      return await Promise.race([this.fontSource(), timeout]);
    } catch (err) {
      this.warn('font-unavailable', `hand font failed: ${errorMessage(err)}`, opId);
      return new FallbackFont();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── preparation per op ────────────────────────────────────────────────

  private async prepare(op: BoardEvent, paceMs: number | null, rate: number): Promise<Prepared> {
    switch (op.op) {
      case 'title':
        return this.prepareText(op, paceMs, rate, 'title');
      case 'write':
        return this.prepareText(op, paceMs, rate, 'write');
      case 'code':
        return this.prepareCode(op, paceMs, rate);
      case 'markdown':
        return this.prepareMarkdown(op, paceMs, rate);
      case 'sketch':
        return this.prepareSketch(op, paceMs, rate);
      case 'highlight':
        return this.prepareHighlight(op, paceMs, rate);
      case 'arrow':
        return this.prepareArrow(op, paceMs, rate);
      case 'erase':
        return this.prepareErase(op);
      case 'newpage':
        return this.prepareNewPage();
    }
  }

  private async prepareText(
    op: BoardEvent,
    paceMs: number | null,
    rate: number,
    style: InkTextStyle,
  ): Promise<Prepared> {
    const text = op.text.trim();
    if (!text) {
      this.warn('empty-text', `${op.op} with empty text`, op.id);
      return EMPTY;
    }
    const font = await this.font(op.id);
    const fontSize = style === 'title' ? TYPE.titleFont : TYPE.writeFont;
    const underline = style === 'title';
    // Titles always start their own line.
    const requested: Placement = style === 'title' && op.place === 'flow' ? 'newline' : op.place;
    const { place, maxWidth } = this.decideTextPlacement(font, text, fontSize, requested);
    const tl = layoutHandText(font, text, {
      fontSize,
      maxWidth,
      seed: op.id,
      align: place === 'center' ? 'center' : 'left',
    });
    this.reportInvalidGlyphs(tl, op.id);
    const w = Math.ceil(tl.width + 6);
    const h = Math.ceil(tl.height + (underline ? 14 : 0));
    const placed = this.layout.place({ w, h, place, ...(op.ref ? { ref: op.ref } : {}) });
    const sid = toShapeId(op.id);
    const props: InkTextProps = {
      text,
      style,
      emphasis: op.emphasis,
      fontSize,
      maxWidth,
      align: place === 'center' ? 'center' : 'left',
      w,
      h,
      progress: 0,
      seed: op.id,
      underline,
    };
    const pace = resolvePace(handwritingMs(inkTextUnits(text, underline)), paceMs, rate);
    const timeline = new Timeline().append(progressTrack(sid, pace.durationMs));
    const b: Bounds = { x: placed.x, y: placed.y, w, h };
    return {
      shapes: [
        { id: sid, type: SHAPE_TYPE.inkText, x: placed.x, y: placed.y, props: { ...props } },
      ],
      timeline,
      bounds: b,
      register: [{ ref: op.id, ids: [sid], bounds: b }],
    };
  }

  /** Flow keeps writing on the line when the phrase fits; otherwise it wraps or breaks the line. */
  private decideTextPlacement(
    font: GlyphSource,
    text: string,
    fontSize: number,
    requested: Placement,
  ): { place: Placement; maxWidth: number } {
    const colW = this.layout.columnWidth;
    if (requested === 'center') return { place: 'center', maxWidth: this.layout.content.w };
    if (requested !== 'flow') return { place: requested, maxWidth: colW };
    const single = measureHandText(font, text, fontSize);
    const remaining = this.layout.remainingLineWidth();
    if (single <= remaining) return { place: 'flow', maxWidth: remaining };
    if (this.layout.atLineStart()) return { place: 'flow', maxWidth: colW };
    return { place: 'newline', maxWidth: colW };
  }

  private async prepareCode(
    op: BoardEvent,
    paceMs: number | null,
    rate: number,
  ): Promise<Prepared> {
    const code = op.text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!code.trim()) {
      this.warn('empty-text', 'code with empty text', op.id);
      return EMPTY;
    }
    const lines = await this.highlighter.highlight(code, op.lang);
    const cols = code.split('\n').reduce((m, l) => Math.max(m, l.length), 1);
    const rows = Math.max(1, lines.length);
    const charW = TYPE.codeFont * TYPE.monoAdvance;
    const lineH = TYPE.codeFont * TYPE.codeLineHeight;
    const innerW = Math.min(
      this.layout.content.w - FRAME_INSET * 2,
      Math.ceil(cols * charW + CODE_PADDING * 2),
    );
    const innerH = Math.ceil(rows * lineH + CODE_PADDING * 2);
    const frameW = innerW + FRAME_INSET * 2;
    const frameH = innerH + FRAME_INSET * 2;
    const placed = this.layout.place({
      w: frameW,
      h: frameH,
      place: op.place,
      ...(op.ref ? { ref: op.ref } : {}),
    });

    const frameId = toShapeId(`${op.id}.frame`);
    const codeId = toShapeId(op.id);
    const frame = this.strokeShape(
      frameId,
      handRoundedRect(frameW, frameH, 14, op.id),
      { x: placed.x, y: placed.y },
      op.emphasis === 'ink' ? 'muted' : op.emphasis,
      'frame',
      2.6,
    );
    const props: CodeBlockProps = {
      code,
      lang: op.lang,
      lines,
      w: innerW,
      h: innerH,
      progress: 0,
      fontSize: TYPE.codeFont,
    };
    const codeShape: ShapeRecordInit = {
      id: codeId,
      type: SHAPE_TYPE.codeBlock,
      x: placed.x + FRAME_INSET,
      y: placed.y + FRAME_INSET,
      props: { ...props },
    };
    const frameMs = penTravelMs(frame.length);
    const typeMs = typewriterMs(code.length);
    const pace = resolvePace(frameMs + typeMs, paceMs, rate);
    const timeline = new Timeline()
      .append(progressTrack(frameId, frameMs))
      .append(progressTrack(codeId, typeMs), 80)
      .stretch(pace.stretch);
    const b: Bounds = { x: placed.x, y: placed.y, w: frameW, h: frameH };
    return {
      shapes: [frame.shape, codeShape],
      timeline,
      bounds: b,
      register: [{ ref: op.id, ids: [frameId, codeId], bounds: b }],
    };
  }

  private async prepareMarkdown(
    op: BoardEvent,
    paceMs: number | null,
    rate: number,
  ): Promise<Prepared> {
    const source = op.text.trim();
    const blocks = parseMarkdown(source);
    if (!source || blocks.length === 0) {
      this.warn('empty-text', 'markdown with empty text', op.id);
      return EMPTY;
    }
    const fontSize = TYPE.mdFont;
    const w = Math.min(this.layout.columnWidth, this.layout.content.w);
    const charsPerLine = (w - MD_PADDING * 2) / (fontSize * TYPE.sansAdvance);
    const measured = this.measureMarkdown?.(source, w, fontSize) ?? null;
    const h =
      measured !== null && measured > 0
        ? Math.ceil(measured)
        : Math.ceil(
            estimateMarkdownLines(blocks, charsPerLine) * fontSize * TYPE.mdLineHeight +
              MD_PADDING * 2,
          );
    const placed = this.layout.place({ w, h, place: op.place, ...(op.ref ? { ref: op.ref } : {}) });
    const sid = toShapeId(op.id);
    const props: MdBlockProps = { source, w, h, progress: 0, fontSize };
    const pace = resolvePace(typewriterMs(markdownCharCount(blocks)), paceMs, rate);
    const timeline = new Timeline().append(progressTrack(sid, pace.durationMs));
    const b: Bounds = { x: placed.x, y: placed.y, w, h };
    return {
      shapes: [
        { id: sid, type: SHAPE_TYPE.mdBlock, x: placed.x, y: placed.y, props: { ...props } },
      ],
      timeline,
      bounds: b,
      register: [{ ref: op.id, ids: [sid], bounds: b }],
    };
  }

  private async prepareSketch(
    op: BoardEvent,
    paceMs: number | null,
    rate: number,
  ): Promise<Prepared> {
    const parsed = parseSketch(op.text);
    for (const w of parsed.warnings) this.warn('sketch-parse', w, op.id);
    if (parsed.nodes.length === 0) {
      if (op.text.trim()) {
        // The model wrote prose in a sketch op: still put it on the paper.
        this.warn('sketch-parse', 'no nodes parsed; rendering the text as handwriting', op.id);
        return this.prepareText({ ...op, op: 'write' }, paceMs, rate, 'write');
      }
      this.warn('empty-text', 'sketch with empty text', op.id);
      return EMPTY;
    }
    const font = await this.font(op.id);
    const sk: SketchLayout = layoutSketch(parsed);
    const pad = 10;
    const w = Math.ceil(sk.width + pad * 2);
    const h = Math.ceil(sk.height + pad * 2);
    const placed = this.layout.place({ w, h, place: op.place, ...(op.ref ? { ref: op.ref } : {}) });
    const origin: Point = { x: placed.x + pad, y: placed.y + pad };

    const shapes: ShapeRecordInit[] = [];
    const register: Prepared['register'] = [];
    const timeline = new Timeline();
    const allIds: string[] = [];

    for (const node of sk.nodes) {
      const nx = origin.x + node.x;
      const ny = origin.y + node.y;
      const ids: string[] = [];
      if (node.kind !== 'note') {
        const sid = toShapeId(`${op.id}.${node.id}.s`);
        const strokes =
          node.kind === 'circle' ? handEllipse(node.w, node.h, sid) : handRect(node.w, node.h, sid);
        const s = this.strokeShape(
          sid,
          strokes,
          { x: nx, y: ny },
          op.emphasis,
          'sketch',
          STROKE_STYLE.size,
        );
        shapes.push(s.shape);
        ids.push(sid);
        timeline.append(progressTrack(sid, penTravelMs(s.length)), 60);
      }
      const label = node.label.trim();
      if (label) {
        const tid = toShapeId(`${op.id}.${node.id}.t`);
        const fontSize = node.kind === 'note' ? TYPE.labelFont * 0.85 : TYPE.labelFont;
        const emphasis: Emphasis = node.kind === 'note' ? 'muted' : op.emphasis;
        const tl = layoutHandText(font, label, {
          fontSize,
          maxWidth: node.w - 16,
          seed: tid,
          align: 'center',
        });
        this.reportInvalidGlyphs(tl, op.id);
        const textShape = this.textShape(tid, label, tl, 'label', emphasis, {
          x: nx + (node.w - tl.width) / 2,
          y: ny + (node.h - tl.height) / 2,
        });
        shapes.push(textShape);
        ids.push(tid);
        timeline.append(progressTrack(tid, handwritingMs(label.length)), 40);
      }
      const nb: Bounds = { x: nx, y: ny, w: node.w, h: node.h };
      register.push({ ref: `${op.id}.${node.id}`, ids, bounds: nb });
      register.push({ ref: node.id, ids, bounds: nb });
      allIds.push(...ids);
    }

    sk.edges.forEach((edge, i) => {
      const start = { x: origin.x + edge.start.x, y: origin.y + edge.start.y };
      const end = { x: origin.x + edge.end.x, y: origin.y + edge.end.y };
      const eid = toShapeId(`${op.id}.e${i}`);
      const s = this.strokeShape(
        eid,
        handArrow(inset(start, end, 5), inset(end, start, 5), eid),
        { x: 0, y: 0 },
        op.emphasis,
        'arrow',
        STROKE_STYLE.size,
      );
      shapes.push(s.shape);
      allIds.push(eid);
      timeline.append(progressTrack(eid, penTravelMs(s.length)), 80);
      const label = edge.label.trim();
      if (label) {
        const tid = toShapeId(`${op.id}.e${i}.t`);
        const tl = layoutHandText(font, label, {
          fontSize: TYPE.labelFont * 0.85,
          maxWidth: 220,
          seed: tid,
        });
        this.reportInvalidGlyphs(tl, op.id);
        shapes.push(
          this.textShape(tid, label, tl, 'label', 'muted', {
            x: origin.x + edge.labelAt.x - tl.width / 2,
            y: origin.y + edge.labelAt.y - tl.height / 2,
          }),
        );
        allIds.push(tid);
        timeline.append(progressTrack(tid, handwritingMs(label.length)), 40);
      }
    });

    const pace = resolvePace(timeline.totalMs, paceMs, rate);
    timeline.stretch(pace.stretch);
    const b: Bounds = { x: placed.x, y: placed.y, w, h };
    register.push({ ref: op.id, ids: allIds, bounds: b });
    return { shapes, timeline, bounds: b, register };
  }

  private async prepareHighlight(
    op: BoardEvent,
    paceMs: number | null,
    rate: number,
  ): Promise<Prepared> {
    const target = this.boundsOf(op.ref);
    if (!target) {
      this.warn('unknown-ref', `highlight: unknown ref "${op.ref}"`, op.id);
      return EMPTY;
    }
    const sid = toShapeId(op.id);
    const emphasis: Emphasis = op.emphasis === 'ink' ? 'accent' : op.emphasis;
    let strokes: Stroke[];
    let origin: Point;
    if (target.w / Math.max(1, target.h) > 3.2) {
      strokes = handUnderline(target.w + 10, sid);
      origin = { x: target.x - 5, y: bottom(target) + 6 };
    } else {
      const px = Math.max(12, target.w * 0.12);
      const py = Math.max(8, target.h * 0.18);
      strokes = handEllipse(target.w + px * 2, target.h + py * 2, sid);
      origin = { x: target.x - px, y: target.y - py };
    }
    const s = this.strokeShape(sid, strokes, origin, emphasis, 'highlight', 3.6);
    const pace = resolvePace(penTravelMs(s.length), paceMs, rate);
    const timeline = new Timeline().append(progressTrack(sid, pace.durationMs));
    return {
      shapes: [s.shape],
      timeline,
      bounds: s.bounds,
      register: [{ ref: op.id, ids: [sid], bounds: s.bounds }],
    };
  }

  private async prepareArrow(
    op: BoardEvent,
    paceMs: number | null,
    rate: number,
  ): Promise<Prepared> {
    const a = this.boundsOf(op.ref);
    const b = this.boundsOf(op.ref2);
    if (!a || !b) {
      this.warn('unknown-ref', `arrow: unknown ref "${a ? op.ref2 : op.ref}"`, op.id);
      return EMPTY;
    }
    const { start, end } = connectNearestSides(a, b);
    const sid = toShapeId(op.id);
    const s = this.strokeShape(
      sid,
      handArrow(inset(start, end, 8), inset(end, start, 8), sid),
      { x: 0, y: 0 },
      op.emphasis,
      'arrow',
      STROKE_STYLE.size,
    );
    const shapes: ShapeRecordInit[] = [s.shape];
    const ids = [sid];
    const timeline = new Timeline().append(progressTrack(sid, penTravelMs(s.length)));
    let bounds: Bounds = s.bounds;
    const label = op.text.trim();
    if (label) {
      const font = await this.font(op.id);
      const tid = toShapeId(`${op.id}.t`);
      const tl = layoutHandText(font, label, {
        fontSize: TYPE.labelFont,
        maxWidth: 260,
        seed: tid,
      });
      const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const len = Math.hypot(end.x - start.x, end.y - start.y) || 1;
      const nx = (end.y - start.y) / len;
      const ny = -(end.x - start.x) / len;
      const at = { x: mid.x + nx * 18 - tl.width / 2, y: mid.y + ny * 18 - tl.height / 2 };
      const t = this.textShape(
        tid,
        label,
        tl,
        'label',
        op.emphasis === 'ink' ? 'muted' : op.emphasis,
        at,
      );
      shapes.push(t);
      ids.push(tid);
      timeline.append(progressTrack(tid, handwritingMs(label.length)), 60);
      bounds = union([bounds, { x: at.x, y: at.y, w: tl.width, h: tl.height }]) ?? bounds;
    }
    const pace = resolvePace(timeline.totalMs, paceMs, rate);
    timeline.stretch(pace.stretch);
    return { shapes, timeline, bounds, register: [{ ref: op.id, ids, bounds }] };
  }

  private async prepareErase(op: BoardEvent): Promise<Prepared> {
    const all = op.ref === 'all' || op.ref === '';
    const refs = all ? [...this.registry.keys()] : [op.ref];
    const ids = new Set<string>();
    for (const r of refs) {
      const e = this.registry.get(r);
      if (e) for (const id of e.ids) ids.add(id);
    }
    if (!all && ids.size === 0) {
      this.warn('unknown-ref', `erase: unknown ref "${op.ref}"`, op.id);
      return EMPTY;
    }
    const timeline = new Timeline();
    for (const id of ids) timeline.at(0, fadeTrack(id, FADE_MS));
    const idList = [...ids];
    return {
      shapes: [],
      timeline,
      bounds: null,
      register: [],
      // Whether the fade finished or was cancelled, half-erased ink is wrong:
      // the shapes go, and the refs with them.
      onSettled: () => {
        if (idList.length)
          this.editor.run(() => this.editor.deleteShapes(idList), { history: 'ignore' });
        for (const id of idList) this.typeById.delete(id);
        for (const [key, e] of this.registry) {
          if (e.ids.some((id) => ids.has(id))) this.registry.delete(key);
        }
        if (all) {
          this.layout.restartPage();
          this.recent = [];
        }
      },
    };
  }

  private async prepareNewPage(): Promise<Prepared> {
    const area = this.layout.newPage();
    return { shapes: [], timeline: new Timeline(), bounds: null, register: [], showPage: area };
  }

  // ── shape builders ────────────────────────────────────────────────────

  private strokeShape(
    id: string,
    strokes: Stroke[],
    origin: Point,
    emphasis: Emphasis,
    role: StrokeRole,
    size: number,
  ): { shape: ShapeRecordInit; length: number; bounds: Bounds } {
    const n = normaliseStrokes(strokes, size * 2);
    const x = origin.x + n.offset.x * -1;
    const y = origin.y + n.offset.y * -1;
    const props: InkStrokeProps = {
      strokes: n.strokes,
      w: n.bounds.w,
      h: n.bounds.h,
      progress: 0,
      emphasis,
      size,
      role,
    };
    const bounds: Bounds = { x, y, w: n.bounds.w, h: n.bounds.h };
    return {
      shape: { id, type: SHAPE_TYPE.inkStroke, x, y, props: { ...props } },
      length: strokesLength(strokes),
      bounds,
    };
  }

  private textShape(
    id: string,
    text: string,
    tl: HandTextLayout,
    style: InkTextStyle,
    emphasis: Emphasis,
    at: Point,
  ): ShapeRecordInit {
    const props: InkTextProps = {
      text,
      style,
      emphasis,
      fontSize: tl.fontSize,
      maxWidth: Math.max(tl.width, tl.fontSize),
      align: 'center',
      w: Math.ceil(tl.width + 6),
      h: Math.ceil(tl.height),
      progress: 0,
      seed: id,
      underline: false,
    };
    return { id, type: SHAPE_TYPE.inkText, x: at.x, y: at.y, props: { ...props } };
  }
}

/** Move `p` towards `towards` by `d` units (arrow endpoints stop short of boxes). */
function inset(p: Point, towards: Point, d: number): Point {
  const len = Math.hypot(towards.x - p.x, towards.y - p.y);
  if (len <= d * 2) return p;
  return { x: p.x + ((towards.x - p.x) / len) * d, y: p.y + ((towards.y - p.y) / len) * d };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
