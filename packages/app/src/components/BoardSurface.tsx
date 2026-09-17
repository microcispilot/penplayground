import { Board } from '@pen/board';
import type { BoardPort } from '@pen/conductor';
import { useEffect, useState } from 'react';
import type { LazyBoard } from '../room/LazyBoard.js';

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
  useEffect(() => {
    if (controller && session) session.board.attach(controller);
  }, [controller, session]);
  return <Board licenseKey={licenseKey} onReady={setController} />;
}
