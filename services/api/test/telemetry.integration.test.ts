import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { ClientMessage, ServerMessage } from '@pen/contracts';
import { SessionTelemetry } from '@pen/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

/**
 * End-to-end proof of the telemetry pipeline (ADR-0011): a real API (fake
 * model, silent synthesizer, PGlite in memory) teaches a scripted session
 * to a WebSocket host who asks a question and reports interactions; the
 * session is ended; `/telemetry` must then cover every engine-owned stage,
 * carry the turn latency, price the session and hold the reports — and a
 * second session on the same topic must reuse the first one's lesson.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

interface Captured {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

let services: Services;
let apiUrl: string;
let dataDir: string;
let stop: () => Promise<void>;
const captured: Captured[] = [];

beforeAll(async () => {
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'pen-telemetry-it-'));
  apiUrl = `http://127.0.0.1:${port}`;
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_PORT: String(port),
    PEN_JWT_SECRET: 'integration-secret-'.repeat(3),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
    PEN_API_URL: apiUrl,
  });
  services = await buildServices(cfg, { flags: PREPARE_FOR_EVERYONE });
  await seedPacks(services.onten, join(DATA_DIR, 'packs'));
  // Observe what would go to PostHog without a token.
  const optedOut = new Set<string>();
  services.analytics = {
    capture: (distinctId: string, event: string, properties: Record<string, unknown> = {}) => {
      if (optedOut.has(distinctId)) return;
      captured.push({ distinctId, event, properties });
    },
    setOptOut: (id: string, value: boolean) => {
      if (value) optedOut.add(id);
      else optedOut.delete(id);
    },
    optedOutOf: (id: string) => optedOut.has(id),
    flush: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as Services['analytics'];
  const { app, rooms, injectWebSocket } = buildApp(services);
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  injectWebSocket(server);
  stop = async () => {
    rooms.sweep(Number.MAX_SAFE_INTEGER);
    await new Promise<void>((r) => server.close(() => r()));
    await services.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}, 60_000);

afterAll(async () => {
  await stop?.();
});

async function host(name: string) {
  const auth = await fetch(`${apiUrl}/api/auth/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => r.json() as Promise<{ token: string; participant: { id: string } }>);
  return {
    token: auth.token,
    id: auth.participant.id,
    headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
  };
}

/** Plays the host: joins, hears `says` sentences, asks one question, reports, ends. */
async function play(
  h: Awaited<ReturnType<typeof host>>,
  opts: { says: number; question: boolean },
): Promise<{ sessionId: string; sayIds: string[]; badFrames: number }> {
  const created = await fetch(`${apiUrl}/api/sessions`, {
    method: 'POST',
    headers: h.headers,
    body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  const sessionId = session.id;
  const sayIds: string[] = [];
  /** Frames the room refused as malformed; the deliberate one below must be among them. */
  let badFrames = 0;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${apiUrl.replace('http', 'ws')}/ws/room`);
    const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
    const timer = setTimeout(() => reject(new Error('session did not progress in time')), 60_000);
    let asked = false;
    let turnDone = false;
    const finish = () => {
      clearTimeout(timer);
      send({ kind: 'report', event: 'captions_off', props: {} });
      send({
        kind: 'report',
        event: 'board_done',
        props: { ms: 640, op: 'write', chars: 22, seq: 1 },
      });
      send({ kind: 'report', event: 'first_audio', props: { 'latency.fromStartMs': 1234 } });
      send({
        kind: 'report',
        event: 'interrupt',
        props: { 'latency.bargeInMs': 12.5, fadeMs: 20 },
      });
      // Never accepted: content-sized props are rejected at the wire.
      send({ kind: 'report', event: 'question_typed', props: { text: 'x'.repeat(200) } } as never);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 150);
    };
    ws.on('open', () => {
      send({ kind: 'auth', token: h.token });
      send({ kind: 'join', sessionId });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.kind === 'error' && msg.code === 'BAD_MESSAGE') {
        badFrames += 1;
        return;
      }
      if (msg.kind === 'error' && msg.code !== 'INTERNAL') {
        clearTimeout(timer);
        reject(new Error(`room error ${msg.code}: ${msg.message}`));
      }
      if (msg.kind === 'say_complete') {
        sayIds.push(msg.sayId);
        if (msg.sayId.startsWith('L0.'))
          send({ kind: 'progress', seq: sayIds.length - 1, clockMs: 1000 });
        if (sayIds.length >= opts.says && !asked) {
          asked = true;
          if (!opts.question) return finish();
          send({ kind: 'interrupt', atSeq: 1, sayId: msg.sayId, offsetMs: 400 });
          send({
            kind: 'transcript',
            utteranceId: 'u1',
            text: 'Why do we divide by the square root of d?',
            final: true,
          });
        }
      }
      if (msg.kind === 'turn_done' && !turnDone) {
        turnDone = true;
        finish();
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const ended = await fetch(`${apiUrl}/api/sessions/${sessionId}/end`, {
    method: 'POST',
    headers: h.headers,
  });
  expect(ended.status).toBe(200);
  return { sessionId, sayIds, badFrames };
}

describe('session telemetry (integration)', () => {
  it('covers every stage, prices the session, keeps the reports, and is host-only', async () => {
    const h = await host('Ada');
    const { sessionId, badFrames } = await play(h, { says: 2, question: true });
    // The deliberate content-sized `report` was refused at the wire, with a code.
    expect(badFrames).toBeGreaterThanOrEqual(1);

    const res = await fetch(`${apiUrl}/api/sessions/${sessionId}/telemetry`, {
      headers: h.headers,
    });
    expect(res.status).toBe(200);
    const t = SessionTelemetry.parse(await res.json());
    expect(t.sessionId).toBe(sessionId);
    expect(t.plan).toBe('free');
    expect(t.canonicalId).toBe('en.how-transformers-work-in-llms');

    const stages = new Set(t.stages.map((s) => s.stage));
    // `image` is the session card's thumbnail generation (ADR-0021): a background
    // call, but the session's own spend, so it is a stage of this session like any other.
    for (const stage of [
      'intake',
      'resolve',
      'context',
      'llm',
      'image',
      'tts',
      'turn',
      'join',
      'board',
    ])
      expect(stages.has(stage as never), stage).toBe(true);
    expect(t.stages.every((s) => s.t >= 0 && s.ms >= 0)).toBe(true);

    // The turn: the learner's final words → the acknowledgement's first chunk.
    expect(t.latency.questionToFirstAudioMs.n).toBe(1);
    expect(t.latency.questionToFirstAudioMs.p50).toBeGreaterThanOrEqual(0);
    expect(t.latency.questionToFirstAudioMs.p50).toBeLessThan(5000);
    expect(t.latency.ttsFirstChunkMs.n).toBeGreaterThan(0);
    expect(t.latency.llmFirstTokenMs.n).toBeGreaterThan(0);
    expect(t.latency.timeToFirstAudioMs).toBe(1234);
    expect(t.latency.bargeInMs).toEqual({ p50: 12.5, p95: 12.5, n: 1 });

    // Costs: every provider call has a line with usd ≥ 0; the fake providers cost nothing.
    expect(t.cost.lines.length).toBeGreaterThan(0);
    expect(t.cost.lines.every((l) => l.usd >= 0 && l.units >= 0)).toBe(true);
    expect(Object.keys(t.cost.byComponent).sort()).toEqual(['image', 'llm', 'onten', 'tts']);
    expect(t.cost.byComponent.llm?.units.tokens_in).toBeGreaterThan(0);
    expect(t.cost.byComponent.tts?.units.bytes).toBeGreaterThan(0);
    // One generation for the card, priced in image tokens like any other call.
    expect(t.cost.byComponent.image?.calls).toBe(2);
    expect(t.cost.byComponent.image?.units.tokens_out).toBeGreaterThan(0);
    expect(t.cost.totalUsd).toBe(0);

    // Interactions from `report`, stamped by the server; the content-sized one never landed.
    const events = t.interactions.map((i) => i.event);
    expect(events).toEqual(
      expect.arrayContaining(['captions_off', 'board_done', 'first_audio', 'interrupt']),
    );
    expect(events).not.toContain('question_typed');
    expect(t.interactions.every((i) => i.participantId === h.id)).toBe(true);
    expect(t.errors).toEqual([]);
    expect(t.totals.questions).toBe(1);
    expect(t.totals.interrupts).toBe(1);
    expect(t.totals.participants).toBe(1);

    // First session on this topic: the pack is seeded (hit), nothing memoised yet.
    expect(t.reuse.packHit).toBe(true);
    expect(t.reuse.memoSegmentsReused).toBe(0);
    expect(t.reuse.memoSegmentsGenerated).toBeGreaterThanOrEqual(1);

    // No content in the telemetry.
    const text = JSON.stringify({ ...t, lines: undefined });
    expect(text).not.toContain('square root');
    expect(text).not.toContain("Let's start");

    // Host only.
    const other = await host('Someone');
    expect(
      (await fetch(`${apiUrl}/api/sessions/${sessionId}/telemetry`, { headers: other.headers }))
        .status,
    ).toBe(403);
    expect((await fetch(`${apiUrl}/api/sessions/${sessionId}/telemetry`)).status).toBe(401);
    expect(
      (await fetch(`${apiUrl}/api/sessions/nope-nope-nope/telemetry`, { headers: h.headers }))
        .status,
    ).toBe(404);

    // PostHog: bounded `stage` events plus one `session_ended` with the flat summary, numbers/codes only.
    const stageEvents = captured.filter(
      (c) => c.event === 'stage' && c.properties.sessionId === sessionId,
    );
    // A sentence still synthesising when /telemetry answered may land afterwards; never fewer.
    expect(stageEvents.length).toBeGreaterThanOrEqual(t.stages.length);
    expect(stageEvents.every((c) => c.distinctId === h.id)).toBe(true);
    const ended = captured.find(
      (c) => c.event === 'session_ended' && c.properties.sessionId === sessionId,
    );
    expect(ended).toBeDefined();
    expect(ended?.properties).toMatchObject({
      canonicalId: 'en.how-transformers-work-in-llms',
      'reuse.packHit': true,
      'cost.totalUsd': 0,
      'latency.timeToFirstAudioMs': 1234,
      questions: 1,
    });
    for (const [k, v] of Object.entries(ended?.properties ?? {}))
      expect(['number', 'boolean', 'string'].includes(typeof v) || v === null, k).toBe(true);
  }, 90_000);

  it('a second session on the same topic reuses the memoised lesson and costs less fresh-equivalent work', async () => {
    const h = await host('Grace');
    const { sessionId } = await play(h, { says: 2, question: false });
    const t = SessionTelemetry.parse(
      await fetch(`${apiUrl}/api/sessions/${sessionId}/telemetry`, { headers: h.headers }).then(
        (r) => r.json(),
      ),
    );
    expect(t.reuse.packHit).toBe(true);
    expect(t.reuse.memoSegmentsReused).toBeGreaterThanOrEqual(1);
    expect(t.reuse.memoSegmentsGenerated).toBe(0);
    // The fake model is priced at $0, so the saving is $0 here; the engine's reuse test prices it as luna.
    expect(t.reuse.savedUsd).toBeGreaterThanOrEqual(0);
    expect(t.reuse.freshEquivalentUsd).toBeGreaterThanOrEqual(t.cost.totalUsd);
    const plan = t.stages.find((s) => s.stage === 'llm' && s.meta.purpose === 'plan');
    expect(plan?.meta.reused).toBe(true);

    // The aggregate across both sessions on disk.
    const stats = (await fetch(`${apiUrl}/api/stats/reuse`, { headers: h.headers }).then((r) =>
      r.json(),
    )) as {
      topics: Array<{
        canonicalId: string;
        sessions: number;
        packHitRate: number;
        memoSegmentsReused: number;
        totalSavedUsd: number;
      }>;
      totals: { sessions: number };
    };
    const topic = stats.topics.find((x) => x.canonicalId === 'en.how-transformers-work-in-llms');
    expect(topic?.sessions).toBeGreaterThanOrEqual(2);
    expect(topic?.packHitRate).toBe(1);
    expect(topic?.memoSegmentsReused).toBeGreaterThanOrEqual(1);
    expect(topic?.totalSavedUsd).toBeGreaterThanOrEqual(0);
    expect((await fetch(`${apiUrl}/api/stats/reuse`)).status).toBe(401);
  }, 90_000);
});
