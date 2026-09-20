import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { observer } from '../src/observability.js';
import { RoomRegistry } from '../src/rooms.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * The seam itself: a real room, ended through `RoomRegistry`, and the row
 * that appears once the queue is drained.
 *
 * Everything else about the derivation is tested on fixtures, which is
 * faster and sharper. This one exists because the two things fixtures cannot
 * show are exactly the two that matter here — that ending a lesson **queues**
 * rather than derives, and that a drain afterwards turns the queue into rows
 * without the room ever having waited for it. An earlier version of this
 * feature derived inline from `end()` and wedged the whole test process
 * (ADR-0027 §2); nothing but this test would have noticed.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'pen-stats-room-'));
let services: Services;
let rooms: RoomRegistry;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
  });
  services = await buildServices(cfg);
  rooms = new RoomRegistry(services);
}, 120_000);

afterAll(async () => {
  services.deriver.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a room that ends', () => {
  it('queues its ledger and derives nothing until the queue is drained', async () => {
    const live = await rooms.create({
      topic: 'I want to learn Swift fundamentals',
      host: { id: 'p_host_0001', name: 'Sam', plan: 'free' },
      band: 'beginner',
      visibility: 'public',
    });
    const id = live.record.id;

    await rooms.end(id);
    // The room is gone and the session row is patched — and the statistics
    // have not been touched, because that is not the room's job.
    expect(services.deriver.pending).toBe(1);
    expect(await services.reports.session(id)).toBeNull();

    expect(await services.deriver.drain()).toBe(1);
    const detail = await services.reports.session(id);
    expect(detail).not.toBeNull();
    expect(detail?.session.sessionId).toBe(id);
    expect(detail?.session.hostId).toBe('p_host_0001');
    expect(detail?.session.topic).toBe('I want to learn Swift fundamentals');
    // A real ledger, so there are real stages in it.
    expect(detail?.stages.length).toBeGreaterThan(0);
    expect(detail?.stages.map((s) => s.stage)).toContain('join');
  }, 60_000);

  it('a lesson that reached its recap is complete, whatever closed the room', async () => {
    const live = await rooms.create({
      topic: 'Reading an ECG strip',
      host: { id: 'p_host_0002', name: 'Lee', plan: 'free' },
      band: 'beginner',
      visibility: 'private',
    });
    const id = live.record.id;
    // What `sweep()` passes when a plan's maximum length runs out. The
    // scripted lesson finishes first, and "why did they stop" has an answer
    // that outranks how the room happened to be closed: they did not stop.
    await rooms.end(id, 'length_ceiling');
    await services.deriver.drain();
    const detail = await services.reports.session(id);
    expect(detail?.session.completed).toBe(true);
    expect(detail?.session.leaveReason).toBe('completed');
  }, 60_000);

  it('ending a room that is not there is not an error and queues nothing', async () => {
    const before = services.deriver.pending;
    await rooms.end('s_not_a_room_01');
    expect(services.deriver.pending).toBe(before);
  });
});

/**
 * Ending is the one moment a session's whole record is written: the row is
 * patched, the summary goes to product analytics, the ledger is handed to the
 * statistics queue, and the room is scheduled for release. Two ways that went
 * wrong, and both of them lose a session permanently rather than noisily.
 *
 * **A failed write took everything after it with it.** `sessions.patch` is
 * awaited in the middle of the tail; one database blip and the `enqueue` and
 * the release below it never ran. `SessionRoom.end` has already set
 * `phase: 'ended'`, so `sweep()` skips that room for ever: the `LiveRoom` — a
 * whole SessionRoom, its metrics and its record — is held for the life of the
 * process, and the session never reaches the statistics at all.
 *
 * **And it could happen twice.** The registry had no claim of its own, so two
 * overlapping calls each ran the whole tail: two `session_ended` events, two
 * telemetry computations, and an `endReason` overwritten by whichever landed
 * second.
 */
describe('a room whose ending goes wrong', () => {
  function countingAnalytics() {
    const captured: Array<{ event: string }> = [];
    const real = services.analytics;
    services.analytics = {
      ...real,
      capture: (_id: string, event: string) => captured.push({ event }),
      flush: async () => undefined,
    } as unknown as Services['analytics'];
    return { captured, restore: () => (services.analytics = real) };
  }

  it('still reaches the statistics queue when the last write fails', async () => {
    const live = await rooms.create({
      topic: 'How a pendulum clock keeps time',
      host: { id: 'p_host_0003', name: 'Ada', plan: 'free' },
      band: 'beginner',
      visibility: 'public',
    });
    const id = live.record.id;
    const before = services.deriver.pending;
    const realPatch = services.sessions.patch.bind(services.sessions);
    const realError = observer.error;
    const reported: string[] = [];
    services.sessions.patch = async () => {
      throw new Error('DB_UNAVAILABLE');
    };
    observer.error = (area: string) => {
      reported.push(area);
      return null;
    };
    try {
      await rooms.end(id);
    } finally {
      services.sessions.patch = realPatch;
      observer.error = realError;
    }
    // The row could not be written — nothing can fix that here — but it is
    // said out loud …
    expect(reported).toContain('rooms.patch_ended');
    // … and the ledger is not lost with it.
    expect(services.deriver.pending).toBe(before + 1);
  }, 60_000);

  it('is one ending, however many callers ask for one', async () => {
    const live = await rooms.create({
      topic: 'Why the sky is blue',
      host: { id: 'p_host_0004', name: 'Kim', plan: 'free' },
      band: 'beginner',
      visibility: 'public',
    });
    const id = live.record.id;
    const analytics = countingAnalytics();
    try {
      // The socket's control/end and the sweeper, in the same beat.
      await Promise.all([rooms.end(id, 'host'), rooms.end(id, 'idle')]);
      // And again, once it is over.
      await rooms.end(id, 'idle');
    } finally {
      analytics.restore();
    }
    expect(analytics.captured.filter((c) => c.event === 'session_ended')).toHaveLength(1);
  }, 60_000);
});

/**
 * Shutdown: a deploy landing under a live lesson.
 *
 * The old handler cleared the statistics queue and exited without ending
 * anything, so a lesson in progress kept `endedAt: null` for ever — out of
 * the catalogue, out of every report, and in the learner's own list as a
 * session that never finished — while up to `STATS_SETTLE_MS` of *finished*
 * sessions went in the bin with the queue. Neither is recoverable from
 * anywhere cheap: the backfill would have to walk every ledger on disk to
 * notice.
 */
describe('the shutdown path', () => {
  it('ends every live room and says how many, with a reason that is not idle', async () => {
    const live = await Promise.all(
      ['Swift fundamentals', 'How TCP handshakes work'].map((topic, i) =>
        rooms.create({
          topic,
          host: { id: `p_shutdown_${i}`, name: 'Sam', plan: 'free' },
          band: 'beginner',
          visibility: 'public',
        }),
      ),
    );
    for (const room of live) expect(room.room.getState().phase).not.toBe('ended');

    expect(await rooms.endAll('shutdown')).toBe(live.length);
    for (const room of live) expect(room.room.getState().phase).toBe('ended');
    for (const room of live) {
      const record = await services.sessions.get(room.record.id);
      // The row a deploy used to leave open for ever.
      expect(record?.endedAt, `${room.record.id} endedAt`).not.toBeNull();
    }

    // And they reach the statistics, which is the other half of what a
    // deploy used to lose: a room the process exited under was queued
    // nowhere and derived never.
    await services.deriver.flush();
    for (const room of live)
      expect(await services.reports.session(room.record.id), room.record.id).not.toBeNull();
  }, 120_000);

  it('ending them all again is nothing to do, not an error', async () => {
    expect(await rooms.endAll('shutdown')).toBe(0);
  });

  it('flushes work the ordinary drain would have left for later', async () => {
    const live = await rooms.create({
      topic: 'Colour theory for interfaces',
      host: { id: 'p_shutdown_flush', name: 'Sam', plan: 'free' },
      band: 'beginner',
      visibility: 'public',
    });
    await rooms.end(live.record.id);
    // The settle pass: `drain()` skips anything whose window has not opened,
    // which is right every few seconds and wrong when the process is going.
    await services.deriver.drain();
    const settling = services.deriver.pending;
    expect(settling, 'a settle pass is waiting').toBeGreaterThan(0);
    expect(await services.deriver.drain(), 'and the ordinary drain leaves it').toBe(0);

    expect(await services.deriver.flush()).toBe(settling);
    expect(services.deriver.pending).toBe(0);
  }, 120_000);
});
