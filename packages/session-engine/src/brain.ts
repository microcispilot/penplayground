import type { IntentOutput } from './schemas.js';

/**
 * Fast, local first pass of the perceive → decide loop. A model call is only
 * needed when this cannot decide. Everything here is cheap, deterministic and
 * unit-tested; it keeps backchannels from becoming turns and commands from
 * becoming questions.
 */
const BACKCHANNEL =
  /^(?:(?:mm+|hm+|uh[- ]?huh|yeah|yep|yes|ok(?:ay)?|right|sure|got it|i see|cool|nice|great|makes sense|alright|go on|continue|thanks|thank you)[.! ]*){1,3}$/i;
const COMMANDS: Array<[RegExp, IntentOutput['command']]> = [
  [
    /^(?:please )?(?:pause|hold on|wait|one (?:sec|second|moment)|stop (?:for a )?(?:sec|second|moment))\b/i,
    'pause',
  ],
  [/^(?:please )?(?:resume|continue|go on|carry on|keep going|unpause)\b/i, 'resume'],
  [
    /^(?:please )?(?:(?:can|could) you )?(?:repeat|say (?:that|it) again|come again|what did you say|one more time)\b/i,
    'repeat',
  ],
  [/^(?:please )?(?:next|skip|move on|let'?s move on)\b/i, 'next'],
  [/^(?:please )?(?:slow(?:er)? down|too fast|slower)\b/i, 'slower'],
  [
    /^(?:please )?(?:end (?:the )?(?:session|lesson|class)|(?:we're|we are|i'm|i am) done|that'?s (?:all|enough)|stop the (?:session|lesson))\b/i,
    'end',
  ],
];

export function classifyLocally(
  text: string,
  opts: { pendingCheck: boolean },
): IntentOutput | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return { intent: 'backchannel', command: 'none' };
  if (!opts.pendingCheck && BACKCHANNEL.test(t) && t.length <= 40)
    return { intent: 'backchannel', command: 'none' };
  for (const [re, command] of COMMANDS)
    if (re.test(t) && t.length <= 60) return { intent: 'command', command };
  if (opts.pendingCheck && t.length <= 200 && !/\?\s*$/.test(t))
    return { intent: 'answer', command: 'none' };
  if (
    /\?\s*$/.test(t) ||
    /^(?:what|why|how|when|where|which|who|can|could|does|do|is|are|should|would|will|what'?s|isn'?t|doesn'?t)\b/i.test(
      t,
    )
  )
    return { intent: 'question', command: 'none' };
  return null;
}

/** Acknowledgement said instantly while the answer is being composed (masks LLM + TTS latency, like a human's "good question"). */
const ACKS: Record<'question' | 'clarify' | 'answer', string[]> = {
  question: [
    'Good question.',
    'Ah, good one.',
    'Right, let me take that.',
    'Yes — good place to stop.',
    'Sure, let me answer that.',
  ],
  clarify: ['Of course.', 'Sure, once more.', 'Let me say that again, differently.'],
  answer: ['Okay.', 'Let me see.', 'Alright.'],
};

export function acknowledgement(kind: keyof typeof ACKS, seed: number): string {
  const list = ACKS[kind];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? 'Okay.';
}

export const BRIDGE_BACK = [
  'Okay — back to where we were.',
  'Right, picking up where we stopped.',
  'Good. Back to it.',
];
export function bridgeBack(seed: number): string {
  return BRIDGE_BACK[Math.abs(seed) % BRIDGE_BACK.length] ?? BRIDGE_BACK[0] ?? 'Back to it.';
}
