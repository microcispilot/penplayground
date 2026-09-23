import { useToast } from '@pen/design';
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../api/client.js';
import { markStartClicked, trackAction, trackInteraction } from './analytics.js';
import { useApp } from './context.js';

/**
 * Start a saved lesson again, as a fresh live session of your own (ADR-0035).
 *
 * This is what "replay" means in the product: not a recording of somebody
 * else's hour, but the same expert teaching the same lesson to *you*, with
 * your questions and your pace, reusing the taught lesson and its voice so it
 * begins in a moment. The same door as typing the topic on Home, with the
 * topic already chosen.
 *
 * One hook so every card, shelf row and saved page starts a session the same
 * way and says the same thing when it cannot: a plan's limit is a fact, said
 * in the ordinary voice; anything else is a fault.
 */
export function useQuickStart(): {
  start: (sessionId: string) => Promise<void>;
  starting: string | null;
  enabled: boolean;
} {
  const { api, features } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [starting, setStarting] = useState<string | null>(null);
  const inFlight = useRef(false);

  const start = useCallback(
    async (sessionId: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStarting(sessionId);
      markStartClicked();
      trackInteraction('quick_start', { sessionId });
      try {
        const { session } = await api.createSession({ replayOf: sessionId });
        navigate(`/room/${session.id}`, { state: { fresh: true } });
      } catch (error) {
        trackAction('start_refused', {
          code: error instanceof ApiError ? error.code : 'NETWORK',
          status: error instanceof ApiError ? error.status : 0,
          source: 'quick_start',
        });
        const calm = error instanceof ApiError && (error.status === 402 || error.status === 403);
        toast(
          error instanceof ApiError ? error.message : 'Could not start the session',
          calm ? 'neutral' : 'danger',
        );
        inFlight.current = false;
        setStarting(null);
      }
    },
    [api, navigate, toast],
  );

  return { start, starting, enabled: features.quick_start };
}
