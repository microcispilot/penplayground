import type { Emphasis } from '@pen/contracts';

/**
 * Prop contracts for the custom shapes. This file has no tldraw import so the
 * executor (and its tests) can build shape records without the editor.
 */

export const SHAPE_TYPE = {
  inkText: 'ink-text',
  inkStroke: 'ink-stroke',
  codeBlock: 'code-block',
  mdBlock: 'md-block',
  noteCard: 'note-card',
} as const;

export type ShapeType = (typeof SHAPE_TYPE)[keyof typeof SHAPE_TYPE];

export type InkTextStyle = 'title' | 'write' | 'label';

export interface InkTextProps {
  text: string;
  style: InkTextStyle;
  emphasis: Emphasis;
  fontSize: number;
  maxWidth: number;
  align: 'left' | 'center';
  w: number;
  h: number;
  /** 0..1 reveal. */
  progress: number;
  /** Jitter seed (the shape id at creation). */
  seed: string;
  /** Titles get an accent underline drawn after the text. */
  underline: boolean;
}

export type StrokeRole = 'sketch' | 'highlight' | 'frame' | 'arrow' | 'underline';

export interface InkStrokeProps {
  /** Strokes as [x, y, pressure] triples, local coordinates. */
  strokes: number[][][];
  w: number;
  h: number;
  progress: number;
  emphasis: Emphasis;
  /** perfect-freehand base size. */
  size: number;
  role: StrokeRole;
}

export interface CodeToken {
  /** text */
  t: string;
  /** colour (hex) or null for the default ink */
  c: string | null;
  /** bold */
  b: boolean;
  /** italic */
  i: boolean;
}
export type CodeLine = CodeToken[];

export interface CodeBlockProps {
  code: string;
  lang: string;
  lines: CodeLine[];
  w: number;
  h: number;
  progress: number;
  fontSize: number;
}

export interface MdBlockProps {
  source: string;
  w: number;
  h: number;
  progress: number;
  fontSize: number;
}

export interface NoteCardProps {
  label: string;
  question: string;
  detail: string;
  /** BCP-47 language the learner asked in; empty for the session's own. */
  lang: string;
  w: number;
  h: number;
}

/** Typography, in world units (the page is 1600 wide; zoom 1 ≈ CSS px). */
/*
 * One scale, not a shout and a whisper (ADR-0051). The title is 1.5× the
 * writing, the writing 1.25× a label, and code and prose sit a step under
 * the label — the ratios a type system uses, so a board reads as one hand
 * at one distance rather than a headline over footnotes.
 */
export const TYPE = {
  titleFont: 34,
  writeFont: 28,
  labelFont: 23,
  codeFont: 24,
  mdFont: 22,
  /** Code and prose are set in the hand too (ADR-0051); their advance is `HAND_ADVANCE_RATIO`. */
  codeLineHeight: 1.55,
  mdLineHeight: 1.5,
} as const;

/** Extra reveal "characters" the title underline costs, so pacing includes it. */
export const UNDERLINE_UNITS = 3;

export function inkTextUnits(text: string, underline: boolean): number {
  return text.length + (underline ? UNDERLINE_UNITS : 0);
}

/** perfect-freehand parameters for every ink stroke (ADR-0005 look). */
export const STROKE_STYLE = {
  size: 3.2,
  thinning: 0.55,
  smoothing: 0.6,
  streamline: 0.5,
  simulatePressure: true,
} as const;

/* A hair of air around a code line: bare lines (ADR-0051), not a box, and the owner found 18 too far apart. */
export const CODE_PADDING = 6;
export const FRAME_INSET = 10;
export const MD_PADDING = 16;
export const NOTE_WIDTH = 300;
export const NOTE_PADDING = 18;
