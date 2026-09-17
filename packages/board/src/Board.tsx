import 'tldraw/tldraw.css';
import './styles/board.css';
import caveatUrl from '@fontsource/caveat/files/caveat-latin-400-normal.woff?url';
import type { BoardEvent, NoteEvent } from '@pen/contracts';
import type { BoardExecution, BoardPort } from '@pen/conductor';
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
import { type Editor, type TLComponents, type TLGridProps, Tldraw, useEditor } from 'tldraw';
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
  /** Font bytes URL; defaults to the bundled Caveat WOFF. */
  fontUrl?: string;
  onReady?: (controller: BoardController) => void;
  /** Non-fatal problems (unknown refs, sketch parse issues). Wire to Sentry. */
  onWarning?: (warning: BoardWarning) => void;
  /** Overlays rendered above the paper (chips, captions). */
  children?: ReactNode;
  ref?: Ref<BoardController | null>;
}

export interface BoardController extends BoardPort {
  readonly editor: Editor;
  readonly executor: BoardExecutor;
  readonly dimmed: boolean;
  exportPng(opts?: ExportPngOptions): Promise<Blob | null>;
}

const GRID = 26;

/** Camera-space dotted grid, 26 px at zoom 1, drawn from the paper-grid token. */
function PaperGrid({ x, y, z }: TLGridProps) {
  const s = GRID * z;
  const xo = 0.5 + x * z;
  const yo = 0.5 + y * z;
  const gx = xo > 0 ? xo % s : s + (xo % s);
  const gy = yo > 0 ? yo % s : s + (yo % s);
  const r = Math.max(0.7, Math.min(1.6, 1.1 * z));
  return (
    <svg className="pen-board__grid" aria-hidden="true">
      <defs>
        <pattern id="pen-paper-grid" width={s} height={s} patternUnits="userSpaceOnUse">
          <circle className="pen-board__grid-dot" cx={gx} cy={gy} r={r} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#pen-paper-grid)" />
    </svg>
  );
}

function PaperBackground() {
  return <div className="tl-background pen-board__paper" />;
}

/** Paper background and grid; no collaborator cursors, no UI panels (hideUi covers the rest). */
const components: TLComponents = {
  Background: PaperBackground,
  Grid: PaperGrid,
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
  onReady,
  onWarning,
  children,
  ref,
}: BoardProps) {
  const [controller, setController] = useState<BoardController | null>(null);
  const [dimmed, setDimmed] = useState(false);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  const onWarningRef = useRef(onWarning);
  onReadyRef.current = onReady;
  onWarningRef.current = onWarning;

  useImperativeHandle<BoardController | null, BoardController | null>(ref, () => controller, [controller]);

  // Load the hand font as early as possible; ink-text upgrades from CSS text once it lands.
  useEffect(() => {
    const url = fontUrl ?? caveatUrl;
    loadHandFont(() => fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))).catch(
      (err: unknown) => {
        onWarningRef.current?.({
          code: 'font-unavailable',
          message: `hand font failed to load: ${err instanceof Error ? err.message : String(err)}`,
        });
      },
    );
  }, [fontUrl]);

  const measureMarkdown = useCallback((source: string, width: number, fontSize: number): number | null => {
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
  }, []);

  const handleMount = useCallback(
    (editor: Editor) => {
      editor.updateInstanceState({ isGridMode: true, isDebugMode: false, isFocusMode: true });
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

  const classes = ['pen-board', interactive ? 'pen-board--interactive' : 'pen-board--static', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-dimmed={dimmed}>
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
    editor.setCameraOptions({ isLocked: !interactive, wheelBehavior: interactive ? 'pan' : 'none' });
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
      execute(op: BoardEvent, opts: { paceMs: number | null }): BoardExecution {
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
