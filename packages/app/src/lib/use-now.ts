import { useEffect, useState } from 'react';

/**
 * A ticking clock for the few things that age on screen — "42s ago" under a
 * line, a reaction fading off the participants. One interval per caller,
 * cleared on unmount, and never faster than the thing it is driving needs.
 */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
