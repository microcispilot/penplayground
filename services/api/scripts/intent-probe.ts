import { JevDecisionsModel, TYPESAFE_DIRECT_BASE_URL, TYPESAFE_DIRECT_MODEL } from '@pen/llm';
import {
  classifyLocally,
  INTENT_MIN_CONFIDENCE,
  INTENT_TIMEOUT_MS,
  JevIntentClassifier,
} from '@pen/session-engine';
import { loadConfig } from '../src/config.js';

/**
 * Run our own intent taxonomy past the real hosted classifier and print what
 * it answered, how sure it was, how long it took and what it cost.
 *
 *   pnpm --filter @pen/api intent:probe
 *
 * It bills the OpenRouter account (`OPENROUTER_API_KEY`), never a plan's
 * OpenAI key, and it is the one way to confirm a deployment's key and model
 * id before `PEN_INTENT_PROVIDER=jev` is turned on. It starts no room and
 * touches no database.
 *
 * `local` in the output means `classifyLocally` already placed that utterance
 * and the classifier is never asked: those turns stay free however this is
 * configured, and the probe calls anyway so the two answers can be compared.
 *
 * What it must not do is decide whether the answers are *right*. It reports
 * the numbers; the taxonomy judgement is the owner's.
 */

/** Real learner turns, two per intent, spread across the room modes. */
const CASES: Array<{ text: string; mode: string; pendingCheck: boolean }> = [
  { text: 'tell me more about the second one', mode: 'teaching', pendingCheck: false },
  {
    text: 'so does that mean the order of the words stops mattering',
    mode: 'teaching',
    pendingCheck: false,
  },
  { text: "hold up, I didn't catch that last part", mode: 'teaching', pendingCheck: false },
  { text: 'sorry, what did you just say?', mode: 'teaching', pendingCheck: false },
  { text: 'gotcha, that makes sense now', mode: 'teaching', pendingCheck: false },
  { text: 'okay', mode: 'teaching', pendingCheck: false },
  { text: "let's move to the next bit", mode: 'teaching', pendingCheck: false },
  { text: "that's a bit too quick for me", mode: 'teaching', pendingCheck: false },
  { text: "okay I'm going to stop here for today", mode: 'teaching', pendingCheck: false },
  { text: 'give me a second, someone is at the door', mode: 'teaching', pendingCheck: false },
  { text: "I think it's because the pressure drops", mode: 'checking', pendingCheck: true },
  { text: 'the square root of d keeps the scores in range', mode: 'checking', pendingCheck: true },
  { text: 'my cat just knocked over a glass of water', mode: 'teaching', pendingCheck: false },
  { text: 'what time is it in Lagos right now', mode: 'teaching', pendingCheck: false },
];

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

async function main(): Promise<void> {
  const cfg = loadConfig();
  // The same route the room picks (`src/intent.ts`): TypeSafe's own endpoint
  // when we have its key, the gateway otherwise. A probe that always went
  // through the gateway would be measuring a path production no longer takes.
  const direct = cfg.PEN_TYPESAFE_API_KEY;
  const apiKey = direct ?? cfg.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('set PEN_TYPESAFE_API_KEY or OPENROUTER_API_KEY');
  const model = direct ? TYPESAFE_DIRECT_MODEL : cfg.PEN_INTENT_MODEL;
  const route = direct ? 'typesafe direct' : 'openrouter';
  const classifier = new JevIntentClassifier({
    decisions: new JevDecisionsModel({
      apiKey,
      model,
      timeoutMs: INTENT_TIMEOUT_MS,
      ...(direct ? { baseUrl: TYPESAFE_DIRECT_BASE_URL } : {}),
      // Only here. In a session a refusal is a status code and nothing else,
      // because the gateway may quote our request — and our request carries
      // what the learner said. These sentences are the operator's own.
      onRefusal: (status, body) => console.error(`  ${status}: ${body.slice(0, 400)}`),
    }),
  });
  console.log(
    `model ${model} · via ${route} · timeout ${INTENT_TIMEOUT_MS} ms · acts at confidence ≥ ${INTENT_MIN_CONFIDENCE}\n`,
  );
  console.log(
    `${pad('utterance', 52)} ${pad('local', 12)} ${pad('jev', 12)} ${pad('command', 8)} ${pad('conf', 5)} ${pad('ms', 5)} usd`,
  );

  const latencies: number[] = [];
  let usd = 0;
  let acted = 0;
  let failed = 0;
  let localHandled = 0;
  for (const c of CASES) {
    const local = classifyLocally(c.text, { pendingCheck: c.pendingCheck });
    if (local) localHandled += 1;
    const started = performance.now();
    try {
      const d = await classifier.classify(c);
      const ms = performance.now() - started;
      latencies.push(ms);
      usd += d.usage?.usd ?? 0;
      const sure = d.confidence === null || d.confidence >= INTENT_MIN_CONFIDENCE;
      if (sure) acted += 1;
      console.log(
        `${pad(c.text, 52)} ${pad(local?.intent ?? '—', 12)} ${pad(d.intent, 12)} ${pad(d.command, 8)} ${pad((d.confidence ?? 1).toFixed(2), 5)} ${pad(String(Math.round(ms)), 5)} ${(d.usage?.usd ?? 0).toFixed(8)}${sure ? '' : '   → under the threshold: falls to the model'}`,
      );
    } catch (error) {
      failed += 1;
      console.log(
        `${pad(c.text, 52)} ${pad(local?.intent ?? '—', 12)} FAILED ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  latencies.sort((a, b) => a - b);
  const at = (p: number) =>
    latencies.length === 0
      ? 0
      : Math.round(
          latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0,
        );
  console.log(
    `\nn=${CASES.length} · ${localHandled} placed locally for free · ${acted} answered above the threshold · ${failed} failed`,
  );
  console.log(
    `latency p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · min ${Math.round(latencies[0] ?? 0)} ms · max ${Math.round(latencies.at(-1) ?? 0)} ms`,
  );
  console.log(
    `cost $${usd.toFixed(8)} total · $${(usd / Math.max(1, latencies.length)).toFixed(8)} per classification`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
