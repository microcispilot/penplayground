import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Expert, PlanCode } from '@pen/contracts';
import {
  FREE_EXPERTS,
  LEGEND_MIN_PLAN,
  planAllowsExpert,
  randomFreeExpert,
  requiredPlanFor,
} from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

/**
 * Who may teach with whom (`packages/contracts/src/expert-access.ts`).
 *
 * The map there is the only place the answer is written. These tests hold the
 * three things that must stay true of it: the catalog on disk agrees with it,
 * the API stamps the answer onto every expert it serves, and a session cannot
 * start with a persona the host's plan does not include — whatever the client
 * believes.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-expert-access-'));
let services: Services;
let app: Hono;
let identity: Identity;

interface Caller {
  id: string;
  headers: Record<string, string>;
}

async function participant(plan: PlanCode): Promise<Caller> {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous: false });
  await services.participants.ensure({
    id: issued.claims.sub,
    name: 'Ada',
    plan,
    anonymous: false,
  });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

const startWith = (expertId: string, caller: Caller) =>
  app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...caller.headers },
    body: JSON.stringify({ topic: 'How Transformers work in LLMs', expertId }),
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
  services = await buildServices(cfg, { flags: PREPARE_FOR_EVERYONE });
  identity = new Identity(cfg.PEN_JWT_SECRET);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the legend map and the catalog', () => {
  it('name exactly the same ten personas, so neither can drift', () => {
    const premium = services.experts
      .all()
      .filter((e) => e.premium)
      .map((e) => e.id)
      .sort();
    expect(premium).toEqual(Object.keys(LEGEND_MIN_PLAN).sort());
  });

  it('splits them six on Standard and four on Professional', () => {
    const by = (plan: PlanCode) =>
      Object.entries(LEGEND_MIN_PLAN)
        .filter(([, p]) => p === plan)
        .map(([id]) => id);
    expect(by('standard')).toHaveLength(6);
    expect(by('professional')).toHaveLength(4);
    expect(by('professional')).toEqual(
      expect.arrayContaining([
        'william-shakespeare',
        'leonardo-da-vinci',
        'isaac-newton',
        'charles-darwin',
      ]),
    );
  });

  it('gives the free plan its two experts and every other modern one to Standard (ADR-0040)', () => {
    expect(FREE_EXPERTS).toEqual(['elena-biology-professor', 'soren-philosophy-professor']);
    for (const id of FREE_EXPERTS) {
      expect(services.experts.get(id), id).not.toBeNull();
      expect(requiredPlanFor(id), id).toBeNull();
      expect(planAllowsExpert('free', id), id).toBe(true);
    }
    for (const e of services.experts.all()) {
      if (e.premium || FREE_EXPERTS.includes(e.id)) continue;
      expect(requiredPlanFor(e.id), e.id).toBe('standard');
      expect(planAllowsExpert('free', e.id), e.id).toBe(false);
      expect(planAllowsExpert('standard', e.id), e.id).toBe(true);
    }
  });

  it('picks one of the two at random for a visit, and only those', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) seen.add(randomFreeExpert());
    expect([...seen].sort()).toEqual([...FREE_EXPERTS].sort());
    expect(randomFreeExpert(() => 0)).toBe('elena-biology-professor');
    expect(randomFreeExpert(() => 0.99)).toBe('soren-philosophy-professor');
  });
});

describe('GET /api/experts — the server stamps the answer', () => {
  it('carries requiredPlan on every expert, the same for every caller', async () => {
    const res = await app.request('/api/experts');
    expect(res.status).toBe(200);
    const { experts } = (await res.json()) as { experts: Expert[] };
    expect(experts.length).toBeGreaterThan(20);
    for (const e of experts) expect(e.requiredPlan).toBe(requiredPlanFor(e.id));
    const aristotle = experts.find((e) => e.id === 'aristotle');
    const newton = experts.find((e) => e.id === 'isaac-newton');
    const free = experts.find((e) => FREE_EXPERTS.includes(e.id));
    const modern = experts.find((e) => !e.premium && !FREE_EXPERTS.includes(e.id));
    expect(aristotle?.requiredPlan).toBe('standard');
    expect(newton?.requiredPlan).toBe('professional');
    expect(free?.requiredPlan).toBeNull();
    expect(modern?.requiredPlan).toBe('standard');
  });

  it('carries it on the single-expert route too', async () => {
    const res = await app.request('/api/experts/socrates');
    const { expert } = (await res.json()) as { expert: Expert };
    expect(expert.requiredPlan).toBe('standard');
  });
});

describe('POST /api/sessions — the plan decides who teaches', () => {
  it('refuses a free host a legend, and says which plan includes them', async () => {
    const free = await participant('free');
    const res = await startWith('socrates', free);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; message: string; upgrade: string };
    expect(body.error).toBe('ENTITLEMENT_REQUIRED');
    expect(body.message).toContain('Standard');
    expect(body.upgrade).toBe('Pricing');
    // Calm, not pushy: it says what the plan includes, never what to do about it.
    expect(body.message).not.toMatch(/upgrade|unlock|locked/i);
  });

  it('lets a Standard host teach with Socrates but not with Newton', async () => {
    const standard = await participant('standard');
    const ok = await startWith('socrates', standard);
    expect(ok.status).toBe(201);
    const { session } = (await ok.json()) as { session: { id: string; expertId: string } };
    expect(session.expertId).toBe('socrates');

    const refused = await startWith('isaac-newton', standard);
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { message: string }).message).toContain('Professional');
  });

  it('lets a Professional host teach with any of them', async () => {
    const pro = await participant('professional');
    const res = await startWith('isaac-newton', pro);
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { expertId: string } };
    expect(session.expertId).toBe('isaac-newton');
  });

  it('never seats a legend for a free host when nobody was asked for', async () => {
    const free = await participant('free');
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...free.headers },
      body: JSON.stringify({ topic: 'The examined life, according to the Greeks' }),
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { expertId: string } };
    expect(requiredPlanFor(session.expertId)).toBeNull();
    // Which means one of the free plan's own two, and nobody else (ADR-0040).
    expect(FREE_EXPERTS).toContain(session.expertId);
  });
});
