import { JevDecisionsModel, TYPESAFE_DIRECT_BASE_URL, TYPESAFE_DIRECT_MODEL } from '@pen/llm';
import { GRADE_MIN_CONFIDENCE, INTENT_TIMEOUT_MS, JevGrader } from '@pen/session-engine';
import { loadConfig } from '../src/config.js';

/**
 * Run real check-in answers past the hosted grader (ADR-0039) and print what
 * it decided, how sure it was, how long it took and what it cost.
 *
 *   pnpm --filter @pen/api grade:probe
 *
 * It bills the TypeSafe (or OpenRouter) account, never a plan's OpenAI key,
 * starts no room and touches no database. What it must not do is decide
 * whether the verdicts are *right*: it prints them beside what a teacher
 * would say, and the judgement is the owner's.
 */
const CHECK = {
  question: 'Quick one: what is a vector here?',
  expected: 'A list of numbers',
  options: ['A word', 'A list of numbers', 'A position'],
  explain: 'A vector is just a list of numbers.',
};
const FREE = {
  question: 'Why do we divide the attention scores by the square root of d?',
  expected:
    'To keep the dot products from growing with the vector length, so softmax stays in range',
  options: [],
  explain: 'Dot products grow with length; scaling keeps the softmax from saturating.',
};

const CASES: Array<{ check: typeof CHECK; answer: string; teacher: string }> = [
  { check: CHECK, answer: 'a list of numbers', teacher: 'correct' },
  { check: CHECK, answer: 'the second one', teacher: 'correct' },
  { check: CHECK, answer: 'numbers, like coordinates', teacher: 'correct' },
  { check: CHECK, answer: 'a word', teacher: 'incorrect' },
  { check: CHECK, answer: 'its position in the sentence', teacher: 'incorrect' },
  { check: CHECK, answer: 'some kind of number thing?', teacher: 'partial' },
  { check: CHECK, answer: "I don't know", teacher: 'incorrect' },
  {
    check: FREE,
    answer: 'so the numbers do not get huge and softmax stays usable',
    teacher: 'correct',
  },
  { check: FREE, answer: 'to make it faster', teacher: 'incorrect' },
  { check: FREE, answer: 'because the values get big', teacher: 'partial' },
  { check: FREE, answer: 'to normalise it, I think, for the length', teacher: 'partial' },
  { check: FREE, answer: 'what was the question again', teacher: 'incorrect' },
];

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const direct = cfg.PEN_TYPESAFE_API_KEY;
  const apiKey = direct ?? cfg.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('set PEN_TYPESAFE_API_KEY or OPENROUTER_API_KEY');
  const model = direct ? TYPESAFE_DIRECT_MODEL : cfg.PEN_INTENT_MODEL;
  const route = direct ? 'typesafe direct' : 'openrouter';
  const grader = new JevGrader({
    decisions: new JevDecisionsModel({
      apiKey,
      model,
      timeoutMs: INTENT_TIMEOUT_MS,
      ...(direct ? { baseUrl: TYPESAFE_DIRECT_BASE_URL } : {}),
      onRefusal: (status, body) => console.error(`  ${status}: ${body.slice(0, 400)}`),
    }),
  });
  console.log(
    `model ${model} · via ${route} · timeout ${INTENT_TIMEOUT_MS} ms · acts at confidence ≥ ${GRADE_MIN_CONFIDENCE}\n`,
  );
  console.log(
    `${pad('answer', 48)} ${pad('teacher', 10)} ${pad('jev', 10)} ${pad('conf', 5)} ${pad('ms', 5)} usd`,
  );
  const latencies: number[] = [];
  let usd = 0;
  let acted = 0;
  let agreed = 0;
  let failed = 0;
  for (const c of CASES) {
    const started = performance.now();
    try {
      const d = await grader.grade({ ...c.check, answer: c.answer });
      const ms = performance.now() - started;
      latencies.push(ms);
      usd += d.usage?.usd ?? 0;
      const sure = d.confidence === null || d.confidence >= GRADE_MIN_CONFIDENCE;
      if (sure) acted += 1;
      if (sure && d.verdict === c.teacher) agreed += 1;
      console.log(
        `${pad(c.answer, 48)} ${pad(c.teacher, 10)} ${pad(d.verdict, 10)} ${pad((d.confidence ?? 1).toFixed(2), 5)} ${pad(String(Math.round(ms)), 5)} ${(d.usage?.usd ?? 0).toFixed(8)}${sure ? '' : '   → under the threshold: the model grades'}`,
      );
    } catch (error) {
      failed += 1;
      console.log(
        `${pad(c.answer, 48)} ${pad(c.teacher, 10)} FAILED ${error instanceof Error ? error.message : String(error)}`,
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
    `\nn=${CASES.length} · ${acted} decided above the threshold · ${agreed} of those match the teacher column · ${failed} failed`,
  );
  console.log(
    `latency p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · min ${Math.round(latencies[0] ?? 0)} ms · max ${Math.round(latencies.at(-1) ?? 0)} ms`,
  );
  console.log(
    `cost $${usd.toFixed(8)} total · $${(usd / Math.max(1, latencies.length)).toFixed(8)} per grade`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
