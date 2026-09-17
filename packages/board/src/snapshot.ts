import type { Editor, TLShapeId } from 'tldraw';

export interface ExportPngOptions {
  /** Shape ids to include; defaults to everything on the current page. */
  ids?: readonly string[];
  /** Output scale relative to page units (0.5 = half-size thumbnail). */
  scale?: number;
  pixelRatio?: number;
  padding?: number;
}

/**
 * PNG of the current page (thumbnails for "My sessions"). Uses tldraw's
 * `Editor.toImage` (the 5.x home of what ADR-0005 calls `exportToBlob`),
 * with the paper background baked in. Returns null when there is nothing to
 * export or the browser cannot rasterise (no canvas in the current host).
 */
export async function exportPng(editor: Editor, opts: ExportPngOptions = {}): Promise<Blob | null> {
  const ids = (opts.ids ?? [...editor.getCurrentPageShapeIds()]) as TLShapeId[];
  if (ids.length === 0) return null;
  try {
    const { blob } = await editor.toImage(ids, {
      format: 'png',
      background: true,
      scale: opts.scale ?? 0.5,
      pixelRatio: opts.pixelRatio ?? 1,
      padding: opts.padding ?? 48,
    });
    return blob;
  } catch (err) {
    console.warn('[board] exportPng failed', err);
    return null;
  }
}
