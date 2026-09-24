import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanCode } from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * Comments under a session, at the API (ADR-0044): everyone reads, an
 * account writes, the author and the host delete, and the limits say why.
 * Also here: visibility became a paid host's choice in the same decision.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-comments-'));
let services: Services;
let app: Hono;
let identity: Identity;

interface Caller {
  id: string;
  headers: Record<string, string>;
}

async function account(name: string, plan: PlanCode): Promise<Caller> {
  const issued = await identity.issue({ name, plan, anonymous: false });
  await services.participants.ensure({ id: issued.claims.sub, name, plan, anonymous: false });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

async function visitor(): Promise<Caller> {
  const res = await app.request('/api/auth/anonymous', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Visitor' }),
  });
  const body = (await res.json()) as { token: string; participant: { id: string } };
  return { id: body.participant.id, headers: { authorization: `Bearer ${body.token}` } };
}

async function seedSession(id: string, hostId: string): Promise<void> {
  await services.sessions.upsert({
    id,
    topic: 'Swift',
    title: 'Swift fundamentals',
    promise: '',
    expertId: 'juno',
    hostId,
    hostName: 'Host',
    band: 'beginner',
    domain: 'computing-data',
    visibility: 'public',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    segments: 0,
    questions: 0,
    recap: [],
    views: 0,
    thumbnail: null,
    canonicalId: null,
    language: 'en-US',
    description: '',
    keywords: [],
    likes: 0,
  });
}

const json = (method: string, path: string, body: unknown, caller?: Caller) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(caller?.headers ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
  });
  services = await buildServices(cfg);
  identity = new Identity(cfg.PEN_JWT_SECRET);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('comments', () => {
  it('everyone reads; a visitor is shown the way in when they try to write', async () => {
    const host = await account('Host', 'free');
    await seedSession('s_comments_1', host.id);
    const v = await visitor();
    const read = await app.request('/api/sessions/s_comments_1/comments');
    expect(read.status).toBe(200);
    expect((await read.json()) as object).toEqual({ comments: [], total: 0, nextBefore: null });
    const write = await json('POST', '/api/sessions/s_comments_1/comments', { body: 'hello' }, v);
    expect(write.status).toBe(403);
    expect((await write.json()) as object).toMatchObject({
      error: 'ACCOUNT_REQUIRED',
      upgrade: 'SignIn',
    });
    // No bearer at all is not "sign in", it is unauthorised.
    expect(
      (await json('POST', '/api/sessions/s_comments_1/comments', { body: 'hello' })).status,
    ).toBe(401);
  });

  it('an account writes, the thread reads newest first with the author, and the count follows', async () => {
    const host = await account('Host', 'free');
    await seedSession('s_comments_2', host.id);
    const ada = await account('Ada', 'free');
    const first = await json(
      'POST',
      '/api/sessions/s_comments_2/comments',
      { body: '  first  ' },
      ada,
    );
    expect(first.status, await first.clone().text()).toBe(200);
    const { comment } = (await first.json()) as { comment: { id: string; body: string } };
    expect(comment.body).toBe('first');
    expect(comment.id.startsWith('c_')).toBe(true);
    await json('POST', '/api/sessions/s_comments_2/comments', { body: 'second' }, ada);
    const page = (await (await app.request('/api/sessions/s_comments_2/comments')).json()) as {
      comments: Array<{ body: string; authorName: string; authorId: string }>;
      total: number;
      nextBefore: number | null;
    };
    expect(page.total).toBe(2);
    expect(page.comments.map((c) => c.body)).toEqual(['second', 'first']);
    expect(page.comments[0]).toMatchObject({ authorName: 'Ada', authorId: ada.id });
    expect(page.nextBefore).toBeNull();
  });

  it('refuses an empty or over-long comment with 400, and a flood with 429', async () => {
    const host = await account('Host', 'free');
    await seedSession('s_comments_3', host.id);
    const lin = await account('Lin', 'standard');
    expect(
      (await json('POST', '/api/sessions/s_comments_3/comments', { body: '   ' }, lin)).status,
    ).toBe(400);
    expect(
      (await json('POST', '/api/sessions/s_comments_3/comments', { body: 'x'.repeat(1001) }, lin))
        .status,
    ).toBe(400);
    expect(
      (await json('POST', '/api/sessions/s_missing/comments', { body: 'x' }, lin)).status,
    ).toBe(404);
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (await json('POST', '/api/sessions/s_comments_3/comments', { body: `n ${i}` }, lin))
        .status;
    }
    expect(last).toBe(429);
  });

  it('the author and the host delete; anyone else is refused', async () => {
    const host = await account('Host', 'free');
    await seedSession('s_comments_4', host.id);
    const ada = await account('Ada', 'free');
    const other = await account('Grace', 'free');
    const post = async () =>
      (
        (await (
          await json('POST', '/api/sessions/s_comments_4/comments', { body: 'mine' }, ada)
        ).json()) as {
          comment: { id: string };
        }
      ).comment.id;
    const byAda = await post();
    const byAdaToo = await post();
    expect(
      (await json('DELETE', `/api/sessions/s_comments_4/comments/${byAda}`, undefined, other))
        .status,
    ).toBe(403);
    expect(
      (await json('DELETE', `/api/sessions/s_comments_4/comments/${byAda}`, undefined, ada)).status,
    ).toBe(200);
    expect(
      (await json('DELETE', `/api/sessions/s_comments_4/comments/${byAdaToo}`, undefined, host))
        .status,
    ).toBe(200);
    // Deleted is gone: a second deletion and a read both say so.
    expect(
      (await json('DELETE', `/api/sessions/s_comments_4/comments/${byAda}`, undefined, ada)).status,
    ).toBe(404);
    const page = (await (await app.request('/api/sessions/s_comments_4/comments')).json()) as {
      total: number;
    };
    expect(page.total).toBe(0);
  });

  it('goes with the session when the host deletes it', async () => {
    const host = await account('Host', 'free');
    await seedSession('s_comments_5', host.id);
    await json('POST', '/api/sessions/s_comments_5/comments', { body: 'kept?' }, host);
    expect(await services.comments.count('s_comments_5')).toBe(1);
    expect((await json('DELETE', '/api/sessions/s_comments_5', undefined, host)).status).toBe(200);
    expect(await services.comments.count('s_comments_5')).toBe(0);
  });
});

describe('visibility is a paid host’s choice (ADR-0044)', () => {
  it('a free host is sent to Pricing; a Standard host may make it private', async () => {
    const free = await account('Free', 'free');
    await seedSession('s_visible_1', free.id);
    const refused = await json(
      'PATCH',
      '/api/sessions/s_visible_1',
      { visibility: 'private' },
      free,
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()) as object).toMatchObject({
      error: 'PLAN_REQUIRED',
      upgrade: 'Pricing',
    });
    const paid = await account('Paid', 'standard');
    await seedSession('s_visible_2', paid.id);
    const ok = await json('PATCH', '/api/sessions/s_visible_2', { visibility: 'private' }, paid);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(((await ok.json()) as { session: { visibility: string } }).session.visibility).toBe(
      'private',
    );
  });
});
