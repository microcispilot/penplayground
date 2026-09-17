import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionRequest, EventStreamRequest, LanguageModel } from '@pen/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TopicIntake } from '../src/language.js';
import { type LiveRoom, RoomRegistry } from '../src/rooms.js';
import { buildServices, type Services } from '../src/services.js';

/** Records every purpose the room registry (and its intake) asks the model for. */
class SpyModel implements LanguageModel {
  readonly id = 'spy';
  readonly purposes: string[] = [];
  constructor(private readonly inner: LanguageModel) {}
  streamEvents(request: EventStreamRequest) {
    this.purposes.push(request.purpose);
    return this.inner.streamEvents(request);
  }
  complete<T>(request: CompletionRequest<T>) {
    this.purposes.push(request.purpose);
    return this.inner.complete(request);
  }
  intakes(): number {
    return this.purposes.filter((p) => p === 'intake').length;
  }
}

let services: Services;
let spy: SpyModel;
let rooms: RoomRegistry;
const created: LiveRoom[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pen-intake-rooms-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
  });
  const base = await buildServices(cfg);
  // `Services` is a plain record, so the registry can be composed with an observed model and intake
  // without any change to buildServices.
  spy = new SpyModel(base.modelFor('free'));
  services = { ...base, modelFor: () => spy, intake: new TopicIntake(spy, join(dir, 'intake')) };
  rooms = new RoomRegistry(services);
}, 60_000);

afterAll(async () => {
  for (const live of created) await rooms.end(live.record.id);
  await services.db.close();
});

const host = { id: 'p_host_0001', name: 'Sam', plan: 'free' as const };

async function create(topic: string): Promise<LiveRoom> {
  const live = await rooms.create({ topic, host, band: 'beginner', visibility: 'public' });
  created.push(live);
  return live;
}

describe('RoomRegistry.create intake', () => {
  it('resolves an English topic without asking the model for an intake completion', async () => {
    const live = await create('I want to learn Swift fundamentals');
    expect(spy.intakes()).toBe(0);
    expect(live.record.title).toBe('Swift Fundamentals');
    expect(live.record.topic).toBe('I want to learn Swift fundamentals');
    expect(live.room.getState().language.toLowerCase().startsWith('en')).toBe(true);
    expect(await services.sessions.get(live.record.id)).toMatchObject({
      title: 'Swift Fundamentals',
      hostId: host.id,
    });
  });

  it('asks for exactly one intake completion for a non-English topic and serves repeats from cache', async () => {
    const first = await create('Quiero aprender los fundamentos de Swift');
    expect(spy.intakes()).toBe(1);
    expect(first.room.getState().language.toLowerCase().startsWith('es')).toBe(true);
    // The fake provider's intake completion names the English canonical title.
    expect(first.record.title).toBe('Quiero aprender los fundamentos de Swift');

    await create('Quiero aprender los fundamentos de Swift');
    expect(spy.intakes()).toBe(1);

    await create('Reading an ECG strip');
    expect(spy.intakes()).toBe(1);
  });

  it('honours an explicit language override without consulting the model', async () => {
    const before = spy.intakes();
    const live = await rooms.create({
      topic: 'Reading an ECG strip',
      host,
      band: 'beginner',
      visibility: 'private',
      language: 'fa-IR',
    });
    created.push(live);
    expect(spy.intakes()).toBe(before);
    expect(live.room.getState().language).toBe('fa-IR');
  });
});
