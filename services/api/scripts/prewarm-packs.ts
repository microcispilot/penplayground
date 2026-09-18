import WebSocket from 'ws';
import { SEEDS } from '../src/seed-packs.js';

/**
 * Teach every seeded pack once, so the first real learner of a prepared topic
 * is not the one who pays for it.
 *
 * A prepared topic still costs a plan call, a model call per segment and a
 * voice call per sentence the *first* time anybody asks for it — measured on
 * this machine with real keys, 4.0–4.9 s to the first word. The second learner
 * pays for none of it: the lesson memo has the words and the lesson voice store
 * (ADR-0017) has the audio, and the first word arrives in about 110 ms. This
 * script makes the product the second learner: run it once against a fresh
 * deployment (or after the seeds change) and the prepared topics are warm for
 * everyone (ADR-0019).
 *
 *   PEN_API_URL=http://127.0.0.1:4010 node --import tsx scripts/prewarm-packs.ts \
 *     [--band beginner] [--language en-US] [--topic "…"] [--timeout 900]
 *
 * It drives the ordinary room protocol — create, join, report progress, end —
 * so what it stores is exactly what a learner would have stored, under exactly
 * the same keys. It never speaks and never asks a question: personal audio is
 * not reusable material and is never written down.
 */
const api = process.env.PEN_API_URL ?? 'http://127.0.0.1:4000';
const args = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  const next = args[i + 1];
  return i >= 0 && next ? next : fallback;
};
const band = value('--band', 'beginner');
const language = value('--language', 'en-US');
const only = value('--topic', '');
const timeoutMs = Number(value('--timeout', '900')) * 1000;

const topics = only ? [only] : SEEDS.map((s) => s.topic);
if (topics.length === 0) {
  console.log('nothing to pre-warm: no seeded packs');
  process.exit(0);
}

let failures = 0;
for (const topic of topics) {
  const started = Date.now();
  try {
    const result = await teach(topic);
    console.log(
      `warmed "${topic}" — session ${result.sessionId}, ${result.sentences} sentences, ` +
        `first audio ${result.firstAudioMs} ms, ${Math.round((Date.now() - started) / 1000)} s`,
    );
  } catch (error) {
    failures += 1;
    console.error(`could not warm "${topic}": ${error instanceof Error ? error.message : error}`);
  }
}
process.exit(failures === 0 ? 0 : 1);

async function teach(topic: string): Promise<{
  sessionId: string;
  sentences: number;
  firstAudioMs: number;
}> {
  // One participant per topic: the free plan allows three sessions a UTC day
  // (ADR-0016), and a warm-up of more than three seeds would otherwise be
  // refused by the product's own limit half way through.
  const auth = (await fetch(`${api}/api/auth/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pen' }),
  }).then((r) => r.json())) as { token: string; participant: { id: string } };
  const headers = { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' };
  const created = await fetch(`${api}/api/sessions`, {
    method: 'POST',
    headers,
    // Private: the warm-up is the product warming itself, not a session anyone
    // should find in the catalogue.
    body: JSON.stringify({ topic, band, language, visibility: 'private' }),
  });
  if (created.status !== 201)
    throw new Error(`create failed: ${created.status} ${await created.text()}`);
  const { session } = (await created.json()) as { session: { id: string } };
  const sessionId = session.id;
  const startedAt = Date.now();
  const seqOfSay = new Map<string, number>();
  let sentences = 0;
  let firstAudioMs = -1;

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${api.replace('http', 'ws')}/ws/room`);
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    };
    ws.on('open', () => {
      send({ kind: 'auth', token: auth.token });
      send({ kind: 'join', sessionId });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (firstAudioMs < 0) firstAudioMs = Date.now() - startedAt;
        return;
      }
      const msg = JSON.parse(String(data)) as { kind: string; [k: string]: unknown };
      if (msg.kind === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`${String(msg.code)}: ${String(msg.message)}`));
        return;
      }
      if (msg.kind === 'cue') {
        const cue = msg.cue as { seq: number; event: { type: string; id?: string } };
        if (cue.event.type === 'say' && cue.event.id) seqOfSay.set(cue.event.id, cue.seq);
      }
      // The room holds the next segment until the host has heard this one; a
      // sentence that finished synthesising is a sentence this listener has
      // "heard", so the whole lesson is written and spoken as fast as the
      // providers will go rather than in real time.
      if (msg.kind === 'say_complete') {
        sentences += 1;
        const seq = seqOfSay.get(String(msg.sayId));
        if (seq !== undefined) send({ kind: 'progress', seq, clockMs: Date.now() - startedAt });
      }
      if (msg.kind === 'state') {
        const state = msg.state as { mode: string; phase: string };
        if (state.phase === 'ended' || state.mode === 'complete') finish();
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const ended = await fetch(`${api}/api/sessions/${sessionId}/end`, { method: 'POST', headers });
  if (!ended.ok) throw new Error(`end failed: ${ended.status}`);
  return { sessionId, sentences, firstAudioMs };
}
