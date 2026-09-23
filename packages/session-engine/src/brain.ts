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
/**
 * What the expert says when the prepared material has nothing on the
 * question (Onten: `missing`). Almost always that means the question is
 * beside today's topic, and a real expert with a class to teach does not
 * guess and does not stall: they acknowledge it, hold the line for the sake
 * of the time, and offer the way to have it properly — another session. One
 * breath, warm, and never a model call.
 */
const OUT_OF_SCOPE: Record<string, string[]> = {
  en: [
    "I hear you — but for the sake of time and today's topic, let's stay with this one. Ask me anything on it, and if that other thread matters to you, start a session on it after and I'll give it the attention it deserves.",
    "Good question, and honestly a different lesson. For today let's keep to what we're on — start a session on that afterwards and we'll do it properly.",
    "That one's outside what we're covering today, so I'll leave it rather than guess. Stay with me on this, and take it up in its own session later.",
  ],
  es: [
    'Te entiendo, pero por el tiempo y el tema de hoy, quedémonos con esto. Pregúntame lo que quieras sobre esto, y ese otro tema lo vemos bien en otra sesión.',
    'Buena pregunta, y en realidad es otra lección. Hoy sigamos con lo nuestro; empieza una sesión sobre eso después y lo hacemos como se debe.',
  ],
  fr: [
    "Je t'entends, mais pour le temps et le sujet du jour, restons sur celui-ci. Pose-moi ce que tu veux dessus, et cette autre question, on la traite dans sa propre séance.",
    "Bonne question, mais c'est une autre leçon. Aujourd'hui, restons sur notre sujet ; lance une séance là-dessus ensuite et on le fera bien.",
  ],
  de: [
    'Verstehe ich — aber der Zeit und dem heutigen Thema zuliebe bleiben wir hier. Frag mich alles dazu, und das andere Thema nimmst du dir danach in einer eigenen Sitzung vor.',
    'Gute Frage, und ehrlich gesagt eine andere Lektion. Heute bleiben wir bei unserem Thema; starte danach eine Sitzung dazu, dann machen wir es richtig.',
  ],
  fa: [
    'می‌فهمم چی می‌گی، ولی به خاطر وقت و موضوع امروز، همین‌جا بمونیم. هر چی درباره‌ی این بپرسی در خدمتم، و اون موضوع رو بعداً تو یه جلسه‌ی جدا درست و حسابی می‌گیم.',
  ],
  ja: [
    'なるほど。ただ今日は時間とテーマの都合で、この話に絞りましょう。それについては、あとで別のセッションでじっくりやりましょう。',
  ],
  zh: [
    '我明白你的意思，不过为了时间和今天的主题，我们先专注在这个上。关于它你随时问我；那个话题之后另开一节课，我们好好讲。',
  ],
};
export function outOfScope(seed: number, language = 'en'): string {
  const list = OUT_OF_SCOPE[language.split('-')[0]?.toLowerCase() ?? 'en'] ?? OUT_OF_SCOPE.en ?? [];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? '';
}

export function bridgeBack(seed: number, language = 'en'): string {
  const list = BRIDGES[language.split('-')[0]?.toLowerCase() ?? 'en'] ?? BRIDGES.en ?? [];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? 'Back to it.';
}
