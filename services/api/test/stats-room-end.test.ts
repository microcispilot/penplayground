import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
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
