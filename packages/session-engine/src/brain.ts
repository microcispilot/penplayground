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

type AckKind = 'question' | 'clarify' | 'answer';
/**
 * Acknowledgement said instantly while the answer is being composed (masks
 * LLM + TTS latency, like a human's "good question"), in the learner's
 * language. Languages without a table get no acknowledgement rather than an
 * English one.
 */
const ACKS: Record<string, Record<AckKind, string[]>> = {
  en: {
    question: [
      'Good question.',
      'Ah, good one.',
      'Right, let me take that.',
      'Sure, let me answer that.',
    ],
    clarify: ['Of course.', 'Sure, once more.'],
    answer: ['Okay.', 'Let me see.'],
  },
  es: {
    question: ['Buena pregunta.', 'Ah, muy buena.', 'Claro, te lo explico.'],
    clarify: ['Claro.', 'Sí, una vez más.'],
    answer: ['Vale.', 'A ver.'],
  },
  fr: {
    question: ['Bonne question.', 'Ah, très bonne question.', 'Bien sûr, je t’explique.'],
    clarify: ['Bien sûr.', 'Oui, encore une fois.'],
    answer: ['D’accord.', 'Voyons.'],
  },
  de: {
    question: ['Gute Frage.', 'Ah, sehr gut.', 'Klar, das erkläre ich.'],
    clarify: ['Natürlich.', 'Ja, noch einmal.'],
    answer: ['Okay.', 'Mal sehen.'],
  },
  it: {
    question: ['Bella domanda.', 'Ah, ottima.', 'Certo, te lo spiego.'],
    clarify: ['Certo.', 'Sì, ancora una volta.'],
    answer: ['Va bene.', 'Vediamo.'],
  },
  pt: {
    question: ['Boa pergunta.', 'Ah, muito boa.', 'Claro, eu explico.'],
    clarify: ['Claro.', 'Sim, mais uma vez.'],
    answer: ['Certo.', 'Vejamos.'],
  },
  nl: {
    question: ['Goede vraag.', 'Ah, mooie vraag.'],
    clarify: ['Natuurlijk.', 'Ja, nog een keer.'],
    answer: ['Oké.', 'Eens kijken.'],
  },
  tr: {
    question: ['Güzel soru.', 'Ah, çok iyi.'],
    clarify: ['Tabii.', 'Evet, bir kez daha.'],
    answer: ['Tamam.', 'Bakalım.'],
  },
  ru: {
    question: ['Хороший вопрос.', 'О, отличный вопрос.'],
    clarify: ['Конечно.', 'Да, ещё раз.'],
    answer: ['Хорошо.', 'Посмотрим.'],
  },
  fa: {
    question: ['سؤال خوبی است.', 'آها، سؤال خیلی خوبی است.'],
    clarify: ['حتماً.', 'بله، یک بار دیگر.'],
    answer: ['باشه.', 'ببینم.'],
  },
  ar: {
    question: ['سؤال جيد.', 'آه، سؤال ممتاز.'],
    clarify: ['بالتأكيد.', 'نعم، مرة أخرى.'],
    answer: ['حسناً.', 'لنرَ.'],
  },
  hi: {
    question: ['अच्छा सवाल।', 'अरे, बहुत अच्छा सवाल।'],
    clarify: ['ज़रूर।', 'हाँ, एक बार फिर।'],
    answer: ['ठीक है।', 'देखते हैं।'],
  },
  ja: {
    question: ['いい質問ですね。', 'ああ、いいところに気づきましたね。'],
    clarify: ['もちろん。', 'はい、もう一度。'],
    answer: ['なるほど。', '見てみましょう。'],
  },
  ko: {
    question: ['좋은 질문이에요.', '아, 아주 좋은 질문이에요.'],
    clarify: ['물론이죠.', '네, 한 번 더요.'],
    answer: ['좋아요.', '한번 볼게요.'],
  },
  zh: {
    question: ['好问题。', '啊，问得好。'],
    clarify: ['当然。', '好，再说一遍。'],
    answer: ['好的。', '我看看。'],
  },
};

export function acknowledgement(kind: AckKind, seed: number, language = 'en'): string | null {
  const table = ACKS[language.split('-')[0]?.toLowerCase() ?? 'en'];
  if (!table) return null;
  const list = table[kind];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? null;
}

const BRIDGES: Record<string, string[]> = {
  en: ['Okay — back to where we were.', 'Right, picking up where we stopped.', 'Good. Back to it.'],
  es: ['Bien, volvamos a donde estábamos.', 'Sigamos donde lo dejamos.'],
  fr: ['Bon, revenons où nous en étions.', 'Reprenons là où nous nous étions arrêtés.'],
  de: ['Gut, zurück zu unserem Thema.', 'Machen wir weiter, wo wir aufgehört haben.'],
  fa: ['خب، برگردیم به جایی که بودیم.'],
  ja: ['では、続きに戻りましょう。'],
  zh: ['好，我们回到刚才的地方。'],
};
export function bridgeBack(seed: number, language = 'en'): string {
  const list = BRIDGES[language.split('-')[0]?.toLowerCase() ?? 'en'] ?? BRIDGES.en ?? [];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? 'Back to it.';
}
