import type { TLAnyShapeUtilConstructor } from 'tldraw';
import { CodeBlockShapeUtil } from './code-block.js';
import { InkStrokeShapeUtil } from './ink-stroke.js';
import { InkTextShapeUtil } from './ink-text.js';
import { MdBlockShapeUtil } from './md-block.js';
import { NoteCardShapeUtil } from './note-card.js';

/** Register on `<Tldraw shapeUtils={boardShapeUtils}>`. Defined once at module scope (tldraw requires stable identity). */
export const boardShapeUtils: readonly TLAnyShapeUtilConstructor[] = [
  InkTextShapeUtil,
  InkStrokeShapeUtil,
  CodeBlockShapeUtil,
  MdBlockShapeUtil,
  NoteCardShapeUtil,
];

export type { CodeBlockShape } from './code-block.js';
export type { InkStrokeShape } from './ink-stroke.js';
export type { InkTextShape } from './ink-text.js';
export type { MdBlockShape } from './md-block.js';
export type { NoteCardShape } from './note-card.js';
export * from './props.js';
export {
  CodeBlockShapeUtil,
  InkStrokeShapeUtil,
  InkTextShapeUtil,
  MdBlockShapeUtil,
  NoteCardShapeUtil,
};
