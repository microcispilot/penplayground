import type { BoardPort } from '@pen/conductor';
import { lazy, Suspense, useEffect, useState } from 'react';
import { dirOf } from '../lib/locale.js';
import type { LazyBoard } from '../room/LazyBoard.js';
import { useRoomStore } from '../room/store.js';

/**
 * tldraw, the ink fonts and the code highlighter are the heaviest thing the
 * product ships, and only two screens ever paint them. Importing `@pen/board`
 * through `lazy()` keeps that whole graph out of the entry bundle, so Explore
 * loads without it. Nothing is lost while the chunk arrives: `LazyBoard`
 * buffers every cue until the real board attaches (ADR-0002 — the audio clock
 * is master, the board only ever follows).
 */
const Board = lazy(async () => ({ default: (await import('@pen/board')).Board }));

/**
 * Start fetching the board chunk before it is rendered. The room calls this
 * while it is still preparing, so the paper is ready by the first cue instead
 * of the download landing on the first stroke.
 */
let boardChunk: Promise<unknown> | null = null;
export function preloadBoard(): Promise<unknown> {
  boardChunk ??= import('@pen/board').catch(() => undefined);
  return boardChunk;
}

/**
 * Mounts the shared board once and attaches its controller to whichever
 * session is current (React StrictMode and reconnects create a new session
 * while the board element stays mounted).
 */
export function BoardSurface({
  session,
  licenseKey,
}: {
  session: { board: LazyBoard } | null;
  licenseKey: string;
}) {
  const [controller, setController] = useState<BoardPort | null>(null);
  const language = useRoomStore((s) => s.state?.language ?? null);
  useEffect(() => {
    if (controller && session) session.board.attach(controller);
  }, [controller, session]);
  return (
    <Suspense fallback={<div className="size-full paper" aria-hidden />}>
      <Board licenseKey={licenseKey} direction={dirOf(language)} onReady={setController} />
    </Suspense>
  );
}
