import 'tldraw/tldraw.css';
import './styles/board.css';
import fallbackUrl from '@fontsource/caveat/files/caveat-latin-400-normal.woff?url';
import handUrl from '@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff?url';
import type { BoardExecuteOptions, BoardExecution, BoardPort } from '@pen/conductor';
import type { BoardEvent, NoteEvent } from '@pen/contracts';
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type Editor, type TLComponents, Tldraw, useEditor } from 'tldraw';
import { CameraDirector } from './camera.js';
import { BoardExecutor, type BoardWarning } from './executor.js';
import { loadHandFont } from './font.js';
import { Layout } from './layout.js';
import { parseMarkdown, renderMarkdownHtml } from './markdown.js';
import { boardShapeUtils } from './shapes/index.js';
import { type ExportPngOptions, exportPng } from './snapshot.js';
import { adaptEditor } from './tldraw-adapter.js';

/**
 * `<Board>`: the paper. Wraps tldraw with the UI hidden, the camera locked
 * (the expert's hand drives it), a dotted-grid paper background from the
 * design tokens, and the custom ink shapes registered. It exposes a
 * `BoardController` — the `BoardPort` the conductor drives — through `ref`
 * or `useBoardController()`.
 *
 * What is deliberately NOT here: the "You're viewing Ada's screen" chip,
 * captions, orb, bottom bar. Render those as `children`; they sit in an
 * overlay above the paper.
 */
export interface BoardProps {
  /** tldraw licence key (production). Localhost needs none. */
  licenseKey?: string;
  /** Allow viewer pan/zoom. Off for the expert layer; reserved for pinch-zoom later. */
  interactive?: boolean;
  className?: string;
  /**
   * Font bytes URL; defaults to the bundled Eraser WOFF.
   *
   * WOFF and not WOFF2, and that is not an oversight: these bytes are parsed
   * by opentype.js, which reads TTF, OTF and WOFF and has no brotli decoder,
   * so a WOFF2 here fails to parse and the board silently falls back to CSS
   * text. The woff2 in the design package is for the CSS `@font-face`; this is
   * the copy the outlines come from.
   */
  fontUrl?: string;
  onReady?: (controller: BoardController) => void;
  /** Non-fatal problems (unknown refs, sketch parse issues). Wire to Sentry. */
  onWarning?: (warning: BoardWarning) => void;
  /** Overlays rendered above the paper (chips, captions). */
  children?: ReactNode;
  ref?: Ref<BoardController | null>;
  /** Which edge writing starts from: the lesson's language decides (ADR-0051). */
  direction?: 'ltr' | 'rtl';
}

export interface BoardController extends BoardPort {
  readonly editor: Editor;
  readonly executor: BoardExecutor;
  readonly dimmed: boolean;
  exportPng(opts?: ExportPngOptions): Promise<Blob | null>;
}

/*
 * There is no grid any more.
 *
 * The board used to be dotted paper — a 26 px camera-space pattern of dots
 * drawn from `--color-paper-grid`. The owner asked for the opposite: *"the
 * board should have a real board like background not with dots."* A real
 * board has no dots on it; what it has is a surface, and that is now the
 * grain and the uneven wipe in `board.css`.
 *
 * `--color-paper-grid` survives, because it was never only the dots — the
 * markdown block still rules `<hr>`, `<pre>` and table cells with it.
 */

/*
 * The writing surface.
 *
 * Three layers, and the two extra ones are why this stopped being a flat
 * colour: the grain is a fractal-noise overlay at `--board-grain`, and the
 * wipe is the uneven brightness of a board that has been cleaned a thousand
 * times. Both are pure CSS on pseudo-elements, so they cost no DOM and scale
 * with the element rather than with the camera — a texture that zoomed with
 * the canvas would swim under the ink.
 *
 * The frame and the chalk tray are deliberately NOT here. They live outside
 * the board in the app's own chrome, because `editor.toImage` rasterises this
 * element and the owner asked for exports to come out clean: a thumbnail grid
 * of framed pictures is a grid of picture frames.
 */
function PaperBackground() {
  return <div className="tl-background pen-board__paper" aria-hidden="true" />;
}

/** Paper background and grid; no collaborator cursors, no UI panels (hideUi covers the rest). */
const components: TLComponents = {
  Background: PaperBackground,
  CollaboratorCursor: null,
  InFrontOfTheCanvas: null,
  ContextMenu: null,
  Toolbar: null,
  StylePanel: null,
  NavigationPanel: null,
  Minimap: null,
  DebugPanel: null,
  DebugMenu: null,
  KeyboardShortcutsDialog: null,
  Dialogs: null,
  Toasts: null,
  A11y: null,
};

export function Board({
  licenseKey,
  interactive = false,
  className,
  fontUrl,
  direction = 'ltr',
  onReady,
  onWarning,
  children,
  ref,
}: BoardProps) {
  const [controller, setController] = useState<BoardController | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The lesson's language decides which edge writing starts from (ADR-0051).
  useEffect(() => {
    controller?.executor.setDirection(direction);
  }, [controller, direction]);
  // A box that grows or shrinks — inline to full view, a phone turning — keeps the page framed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !controller || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => controller.executor.camera?.refit());
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [controller]);
  const [dimmed, setDimmed] = useState(false);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  const onWarningRef = useRef(onWarning);
  onReadyRef.current = onReady;
  onWarningRef.current = onWarning;

  useImperativeHandle<BoardController | null, BoardController | null>(ref, () => controller, [
    controller,
  ]);

  /*
   * Load the hand font as early as possible; ink-text upgrades from CSS text
   * once it lands.
   *
   * This — not `--font-hand` — is what the handwriting is actually drawn from.
   * The board does not set text in a font: it takes glyph *outlines* out of
   * these bytes and reveals them stroke by stroke, which is why the CSS
   * variable alone changed nothing when Eraser was first wired up. The
   * variable governs the fallback text that shows before the bytes arrive, and
   * the markdown block; this governs the handwriting.
   */
  useEffect(() => {
    const url = fontUrl ?? handUrl;
    const bytes = (u: string) => () =>
      fetch(u).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))));
    /*
     * Patrick Hand first (ADR-0051), Caveat for the glyphs it does not have.
     *
     * Patrick Hand covers Latin, its punctuation and the brackets; the arrows
     * and the maths (`→`, `√`, `≤`, `∑`, `π`…) it lacks, and a lesson about
     * maths or code meets every one. CSS falls back per glyph on its own;
     * outlines do not, so `LayeredFont` does it here, and a missing character
     * is a Caveat character rather than a blank in the middle of an equation.
     */
    loadHandFont(bytes(url), bytes(fallbackUrl)).catch((err: unknown) => {
      onWarningRef.current?.({
        code: 'font-unavailable',
        message: `hand font failed to load: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }, [fontUrl]);

  const measureMarkdown = useCallback(
    (source: string, width: number, fontSize: number): number | null => {
      const host = measureRef.current;
      if (!host) return null;
      // Render the same markup the shape uses, off-screen, and read its height.
      const el = document.createElement('div');
      el.className = 'pen-md';
      el.style.width = `${width}px`;
      el.style.fontSize = `${fontSize}px`;
      el.style.padding = '16px';
      el.style.boxSizing = 'border-box';
      // Our renderer escapes everything it emits, so this is inert markup.
      el.innerHTML = renderMarkdownHtml(parseMarkdown(source));
      host.appendChild(el);
      const h = el.getBoundingClientRect().height;
      host.removeChild(el);
      return h > 0 ? h * 1.08 : null;
    },
    [],
  );

  const handleMount = useCallback(
    (editor: Editor) => {
      // isGridMode stays off: there is no grid component any more (see PaperBackground).
      editor.updateInstanceState({ isGridMode: false, isDebugMode: false, isFocusMode: true });
      editor.setCameraOptions({
        isLocked: !interactive,
        wheelBehavior: interactive ? 'pan' : 'none',
        zoomSteps: [0.6, 0.8, 1, 1.2],
      });
      editor.setCurrentTool('hand');
      editor.selectNone();

      const editorLike = adaptEditor(editor);
      const layout = new Layout();
      const camera = new CameraDirector(editorLike);
      const executor = new BoardExecutor({
        editor: editorLike,
        layout,
        camera,
        measureMarkdown,
        onWarning: (w) => onWarningRef.current?.(w),
        onDimmed: setDimmed,
      });
      camera.showPage(layout.pageArea, false);

      const state = { dimmed: false };
      const ctrl: BoardController = {
        editor,
        executor,
        get dimmed() {
          return state.dimmed;
        },
        execute: (op, opts) => executor.execute(op, opts),
        pinNote: (note, id) => executor.pinNote(note, id),
        setDimmed: (d) => {
          state.dimmed = d;
          executor.setDimmed(d);
        },
        clear: () => executor.clear(),
        exportPng: (opts) => exportPng(editor, { ids: executor.shapeIds(), ...opts }),
      };
      setController(ctrl);
      onReadyRef.current?.(ctrl);
      return () => {
        executor.dispose();
        setController(null);
      };
    },
    [interactive, measureMarkdown],
  );

  const classes = [
    'pen-board',
    interactive ? 'pen-board--interactive' : 'pen-board--static',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={hostRef} className={classes} data-dimmed={dimmed}>
      <Tldraw
        hideUi
        shapeUtils={boardShapeUtils}
        components={components}
        colorScheme="light"
        onMount={handleMount}
        autoFocus={false}
        {...(licenseKey !== undefined ? { licenseKey } : {})}
      >
        <CameraLock interactive={interactive} />
      </Tldraw>
      <div className="pen-board__dim" data-dimmed={dimmed} aria-hidden="true" />
      {children ? <div className="pen-board__overlay">{children}</div> : null}
      <div className="pen-board__measure" ref={measureRef} aria-hidden="true" />
    </div>
  );
}

/** Keeps camera options in sync if `interactive` flips after mount. */
function CameraLock({ interactive }: { interactive: boolean }) {
  const editor = useEditor();
  useEffect(() => {
    editor.setCameraOptions({
      isLocked: !interactive,
      wheelBehavior: interactive ? 'pan' : 'none',
    });
  }, [editor, interactive]);
  return null;
}

// ── hook ────────────────────────────────────────────────────────────────

export interface BoardControllerHandle {
  /** Pass as `ref` to `<Board>`. */
  ref: (c: BoardController | null) => void;
  /** The mounted controller, or null before mount / after unmount. */
  current: BoardController | null;
  /** A stable BoardPort that forwards to the mounted board (no-ops with a warning before mount). */
  port: BoardPort;
  ready: boolean;
}

/**
 * `const board = useBoardController(); <Board ref={board.ref} />; conductor.board = board.port`.
 * The port is stable across renders so the conductor can hold it for the session.
 */
export function useBoardController(onWarning?: (w: BoardWarning) => void): BoardControllerHandle {
  const ref = useRef<BoardController | null>(null);
  const [ready, setReady] = useState(false);
  const warnRef = useRef(onWarning);
  warnRef.current = onWarning;

  const setRef = useCallback((c: BoardController | null) => {
    ref.current = c;
    setReady(Boolean(c));
  }, []);

  const port = useMemo<BoardPort>(() => {
    const missing = (what: string) =>
      warnRef.current?.({ code: 'op-failed', message: `${what} before the board mounted` });
    return {
      execute(op: BoardEvent, opts: BoardExecuteOptions): BoardExecution {
        const c = ref.current;
        if (c) return c.execute(op, opts);
        missing(`execute(${op.op})`);
        return settledExecution();
      },
      pinNote(note: NoteEvent, id: string) {
        const c = ref.current;
        if (c) c.pinNote(note, id);
        else missing('pinNote');
      },
      setDimmed(d: boolean) {
        ref.current?.setDimmed(d);
      },
      clear() {
        ref.current?.clear();
      },
    };
  }, []);

  return { ref: setRef, current: ref.current, port, ready };
}

function settledExecution(): BoardExecution {
  return { done: Promise.resolve(), pause() {}, resume() {}, finish() {}, cancel() {} };
}
