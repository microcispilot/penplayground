import { Board } from '@pen/board';
import type { BoardPort } from '@pen/conductor';
import { useCallback } from 'react';
import type { LazyBoard } from '../room/LazyBoard.js';

/** Mounts the shared board and attaches its controller to the session's lazy board port. */
export function BoardSurface({
  session,
  licenseKey,
}: {
  session: { board: LazyBoard } | null;
  licenseKey: string;
}) {
  const onReady = useCallback(
    (port: BoardPort) => {
      session?.board.attach(port);
    },
    [session],
  );
  return <Board licenseKey={licenseKey} onReady={onReady} />;
}
