import type { CodeBlockProps, InkStrokeProps, InkTextProps, MdBlockProps, NoteCardProps } from './props.js';

/**
 * tldraw 5 types `TLShape` as an indexed map keyed by shape type; custom
 * shapes join it by augmenting `TLGlobalShapePropsMap` (the documented
 * pattern). This is why `@tldraw/tlschema` is a direct dependency: module
 * augmentation only merges when the module resolves from this package.
 */
declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    'ink-text': InkTextProps;
    'ink-stroke': InkStrokeProps;
    'code-block': CodeBlockProps;
    'md-block': MdBlockProps;
    'note-card': NoteCardProps;
  }
}
