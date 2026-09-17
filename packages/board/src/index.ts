/// <reference path="./types/assets.d.ts" />
/// <reference path="./types/opentype.d.ts" />
export {
  Board,
  type BoardController,
  type BoardControllerHandle,
  type BoardProps,
  useBoardController,
} from './Board.js';
export { CameraDirector, type CameraOptions, DEFAULT_CAMERA } from './camera.js';
export {
  AnimationClock,
  type ClockState,
  createRafTicker,
  ManualTicker,
  type Ticker,
} from './clock.js';
export {
  type CameraMove,
  type EditorLike,
  type ShapeRecordInit,
  type ShapeRecordUpdate,
  toShapeId,
} from './editor-like.js';
export {
  BoardExecutor,
  type BoardExecutorOptions,
  type BoardWarning,
  type BoardWarningCode,
} from './executor.js';
export {
  FallbackFont,
  type GlyphSource,
  getHandFont,
  HandFont,
  loadHandFont,
  parseHandFont,
  setHandFont,
  whenHandFont,
} from './font.js';
export type { Bounds, Point } from './geometry.js';
export {
  type GlyphPlacement,
  type HandTextLayout,
  type HandTextOptions,
  layoutHandText,
  measureHandText,
  wrapHandText,
} from './glyphs.js';
export {
  type CodeHighlighter,
  createShikiHighlighter,
  plainLines,
  resolveLang,
} from './highlight.js';
export {
  DEFAULT_LAYOUT,
  Layout,
  type LayoutOptions,
  MARGIN,
  PAGE_H,
  PAGE_STRIDE,
  PAGE_W,
  type Placed,
  type PlaceRequest,
} from './layout.js';
export {
  escapeHtml,
  type MdBlock,
  type MdInline,
  markdownCharCount,
  parseMarkdown,
  renderMarkdownHtml,
} from './markdown.js';
export {
  FADE_MS,
  HAND_CPS,
  handwritingMs,
  MAX_STRETCH,
  MIN_OP_MS,
  PEN_UNITS_PER_SECOND,
  penTravelMs,
  type ResolvedPace,
  resolvePace,
  TYPEWRITER_CPS,
  typewriterMs,
} from './pacing.js';
export * from './primitives.js';
export * from './shapes/index.js';
export {
  type LaidOutEdge,
  type LaidOutNode,
  layoutSketch,
  type ParsedSketch,
  parseSketch,
  type SketchEdge,
  type SketchLayout,
  type SketchNode,
} from './sketch.js';
export { type ExportPngOptions, exportPng } from './snapshot.js';
export { fadeTrack, progressTrack, Timeline, type Track } from './timeline.js';
export { adaptEditor } from './tldraw-adapter.js';
