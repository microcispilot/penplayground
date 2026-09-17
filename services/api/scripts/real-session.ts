import WebSocket from 'ws';

/**
 * Drives one short real session against a running API (real model + voice
 * keys) the way the host's client would, so the telemetry pipeline can be
 * verified end to end with real providers (ADR-0011):
 *
 *   PEN_API_URL=http://127.0.0.1:4020 node --import tsx scripts/real-session.ts \
 *     [--topic "How Transformers work in LLMs"] [--says 2] [--no-question] [--error]
 *
 * It authenticates, creates the session, joins the room, reports progress like
 * a conductor, asks one question after `says` sentences, reports a few client
 * interactions and latencies, optionally raises the dev test error (Sentry →
 * ledger ref), ends the session, and prints the session id and the telemetry.
 */
const api = process.env.PEN_API_URL ?? 'http://127.0.0.1:4020';
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const topic = value('--topic', 'How Transformers work in LLMs');
const wantSays = Number(value('--says', '2'));
const question = !flag('--no-question');
const raiseError = flag('--error');

const auth = (await fetch(`${api}/api/auth/anonymous`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Ada' }),
}).then((r) => r.json())) as { token: string; participant: { id: string } };
const headers = { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' };
const started = Date.now();
const created = await fetch(`${api}/api/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ topic }),
});
if (created.status !== 201)
  throw new Error(`create failed: ${created.status} ${await created.text()}`);
const { session } = (await created.json()) as { session: { id: string; expertId: string } };
const sessionId = session.id;
console.log(`session ${sessionId} expert ${session.expertId} (host ${auth.participant.id})`);

const says: string[] = [];
let questionAt = 0;
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(`${api.replace('http', 'ws')}/ws/room`);
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const timer = setTimeout(() => reject(new Error('timeout')), 180_000);
  let asked = false;
  let firstAudio = false;
  const finish = () => {
    clearTimeout(timer);
    send({ kind: 'report', event: 'captions_off', props: {} });
    send({ kind: 'report', event: 'captions_on', props: {} });
    send({
      kind: 'report',
      event: 'board_done',
      props: { ms: 910, op: 'write', chars: 24, seq: 1 },
    });
    setTimeout(() => {
      ws.close();
      resolve();
    }, 200);
  };
  ws.on('open', () => {
    send({ kind: 'auth', token: auth.token });
    send({ kind: 'join', sessionId });
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!firstAudio) {
        firstAudio = true;
        send({
          kind: 'report',
          event: 'first_audio',
          props: { 'latency.fromStartMs': Date.now() - started },
        });
        console.log(`first audio after ${Date.now() - started} ms`);
      }
      if (asked && questionAt) {
        send({
          kind: 'report',
          event: 'answer_started',
          props: { 'latency.questionToFirstAudioMs': Date.now() - questionAt, thread: 't1' },
        });
        questionAt = 0;
      }
      return;
    }
    const msg = JSON.parse(String(data)) as { kind: string; [k: string]: unknown };
    if (msg.kind === 'error') console.log('room error', msg.code, msg.message);
    if (msg.kind === 'state') {
      const st = msg.state as { phase: string; mode: string };
      send({ kind: 'report', event: 'phase_shown', props: { phase: st.phase, mode: st.mode } });
    }
    if (msg.kind === 'say_complete') {
      const sayId = String(msg.sayId);
      says.push(sayId);
      console.log(`say_complete ${sayId} (${msg.durationMs} ms) at +${Date.now() - started} ms`);
      if (sayId.startsWith('L0.'))
        send({ kind: 'progress', seq: says.length - 1, clockMs: Date.now() - started });
      if (says.length >= wantSays && !asked) {
        asked = true;
        if (!question) return finish();
        send({ kind: 'interrupt', atSeq: says.length - 1, sayId, offsetMs: 400 });
        send({
          kind: 'report',
          event: 'interrupt',
          props: { 'latency.bargeInMs': 14.2, fadeMs: 20 },
        });
        questionAt = Date.now();
        send({ kind: 'report', event: 'question_typed', props: { chars: 42 } });
        send({
          kind: 'transcript',
          utteranceId: 'u1',
          text: 'Why do we divide by the square root of d?',
          final: true,
        });
        console.log(`asked at +${questionAt - started} ms`);
      }
    }
    if (msg.kind === 'turn_done') {
      console.log(`turn_done ${msg.thread} at +${Date.now() - started} ms`);
      // Let the last answer sentence finish streaming before ending.
      setTimeout(finish, 1500);
    }
  });
  ws.on('error', (e) => {
    clearTimeout(timer);
    reject(e);
  });
});

if (raiseError) {
  const r = await fetch(`${api}/api/dev/sessions/${sessionId}/error`, { method: 'POST', headers });
  console.log('dev error', r.status, await r.text());
}
const ended = await fetch(`${api}/api/sessions/${sessionId}/end`, { method: 'POST', headers });
console.log('end', ended.status);
const telemetry = await fetch(`${api}/api/sessions/${sessionId}/telemetry`, { headers }).then((r) =>
  r.json(),
);
console.log(JSON.stringify({ sessionId, telemetry }, null, 2));
