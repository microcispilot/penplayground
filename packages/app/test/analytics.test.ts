import { InteractionName, InteractionProps } from '@pen/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAnalyticsForTests, setRoomReporter, trackInteraction } from '../src/lib/analytics.js';

describe('interaction reporting', () => {
  beforeEach(() => resetAnalyticsForTests());

  /**
   * The replay scrubber's seek. `replay_seeked` is reserved in the telemetry
   * contract (ADR-0011) and carries where the viewer was and where they went —
   * two numbers, never a sentence.
   */
  it('replay_seeked is a contract event carrying from and to in ms', () => {
    expect(InteractionName.safeParse('replay_seeked').success).toBe(true);
    const props = InteractionProps.safeParse({ fromMs: 1200, toMs: 48_300 });
    expect(props.success).toBe(true);
  });

  it('forwards an interaction to the room reporter with its props intact', () => {
    const seen: Array<{ event: string; props: Record<string, unknown> }> = [];
    setRoomReporter((event, props) => seen.push({ event, props }));
    trackInteraction('replay_seeked', { fromMs: 1200, toMs: 48_300 });
    expect(seen).toEqual([{ event: 'replay_seeked', props: { fromMs: 1200, toMs: 48_300 } }]);
  });

  it('keeps working with no reporter installed — a replay has no room to report to', () => {
    setRoomReporter(null);
    expect(() => trackInteraction('replay_seeked', { fromMs: 0, toMs: 500 })).not.toThrow();
  });

  it('does not report the steps the room validates itself (ad events)', () => {
    const seen: string[] = [];
    setRoomReporter((event) => seen.push(event));
    trackInteraction('ad_started', { adId: 'a1' }, { report: false });
    trackInteraction('replay_started', { cues: 3 });
    expect(seen).toEqual(['replay_started']);
  });
});
