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
/**
 * What the expert says to a question on a plan that does not include answers
 * (ADR-0040). The learner has to feel heard — the question was a good one
 * and it was understood — and be told plainly what unlocks the answer, in
 * one warm breath, before the lesson goes on. Never a wall, never a model
 * call. The client draws the way to Pricing beside it (`nudge`).
 */
const QUESTIONS_UPGRADE: Record<string, string[]> = {
  en: [
    'I hear you — that’s a good question, and I’d love to take it. Answering questions live is part of the paid plans; upgrade and I’ll take every one. For now, let me keep going.',
    'Good question. I can only take questions on a paid plan — upgrade and I’ll answer as we go. Let me carry on for now.',
  ],
  es: [
    'Te escucho: es una buena pregunta y me encantaría responderla. Responder preguntas en vivo forma parte de los planes de pago; mejora tu plan y las tomaré todas. Por ahora, sigo.',
  ],
  fr: [
    'Je t’entends, c’est une bonne question et j’aimerais y répondre. Répondre aux questions en direct fait partie des offres payantes ; passe à l’une d’elles et je prendrai chacune. Pour l’instant, je continue.',
  ],
  de: [
    'Ich höre dich — eine gute Frage, die ich gern beantworten würde. Fragen live zu beantworten gehört zu den bezahlten Plänen; mit einem Upgrade nehme ich jede. Jetzt mache ich erst einmal weiter.',
  ],
  it: [
    'Ti sento: è una bella domanda e mi piacerebbe rispondere. Rispondere alle domande dal vivo fa parte dei piani a pagamento; con un upgrade le prendo tutte. Per ora, vado avanti.',
  ],
  pt: [
    'Eu te ouço — boa pergunta, e adoraria responder. Responder perguntas ao vivo faz parte dos planos pagos; faça o upgrade e eu respondo todas. Por agora, sigo em frente.',
  ],
  nl: [
    'Ik hoor je — goede vraag, en ik zou hem graag beantwoorden. Vragen live beantwoorden hoort bij de betaalde plannen; upgrade en ik neem ze allemaal. Voor nu ga ik door.',
  ],
  tr: [
    'Seni duyuyorum, güzel bir soru; cevaplamayı çok isterdim. Soruları canlı cevaplamak ücretli planlara dahil; yükseltirsen hepsini alırım. Şimdilik devam ediyorum.',
  ],
  ru: [
    'Слышу тебя — хороший вопрос, и я бы с радостью ответил. Ответы на вопросы вживую входят в платные планы; перейди на один из них, и я отвечу на каждый. А пока продолжаю.',
  ],
  fa: [
    'می‌شنوم — سؤال خوبی است و دوست داشتم جوابش را بدهم. پاسخ زندهٔ سؤال‌ها بخشی از طرح‌های پولی است؛ با ارتقا، هر سؤالی را جواب می‌دهم. فعلاً ادامه می‌دهم.',
  ],
  ar: [
    'أسمعك — سؤال جيد وكنت أود الإجابة عنه. الإجابة عن الأسئلة مباشرة جزء من الخطط المدفوعة؛ بالترقية سأجيب عن كل سؤال. الآن، دعني أكمل.',
  ],
  hi: [
    'मैं सुन रहा हूँ — अच्छा सवाल है, और मुझे जवाब देना अच्छा लगता। लाइव सवालों के जवाब पेड प्लान का हिस्सा हैं; अपग्रेड करें और मैं हर सवाल लूँगा। फ़िलहाल, आगे बढ़ते हैं।',
  ],
  ja: [
    '聞こえていますよ。いい質問ですし、ぜひ答えたいところです。質問にその場で答えるのは有料プランの機能なので、アップグレードすればどの質問にもお答えします。今は先に進みますね。',
  ],
  ko: [
    '들었어요. 좋은 질문이고, 꼭 답해 드리고 싶네요. 질문에 바로 답하는 건 유료 플랜에 포함돼 있어요. 업그레이드하시면 모든 질문에 답할게요. 지금은 계속 진행할게요.',
  ],
  zh: [
    '我听到了——这是个好问题，我很想回答。现场回答问题是付费方案的一部分；升级后我会回答每一个。现在，我先继续讲。',
  ],
};
export function questionsUpgrade(seed: number, language = 'en'): string {
  const list =
    QUESTIONS_UPGRADE[language.split('-')[0]?.toLowerCase() ?? 'en'] ?? QUESTIONS_UPGRADE.en ?? [];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? '';
}

export function outOfScope(seed: number, language = 'en'): string {
  const list = OUT_OF_SCOPE[language.split('-')[0]?.toLowerCase() ?? 'en'] ?? OUT_OF_SCOPE.en ?? [];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? '';
}

/**
 * The floor in a room (ADR-0037): calling on a raised hand, letting a silent
 * one go, and letting a withdrawn one go. `{name}` is the guest's first
 * name. Said the way a teacher says it — by name, warmly, and briefly,
 * because the class is waiting.
 */
const CALL_ON: Record<string, string[]> = {
  en: [
    'Okay {name}, I see your hand — go ahead.',
    '{name}, you had your hand up. Go on.',
    'Yes, {name} — what have you got?',
  ],
  es: ['Vale, {name}, veo tu mano — adelante.', '{name}, tenías la mano levantada. Dime.'],
  fr: ['D’accord {name}, je vois ta main — vas-y.', '{name}, tu avais la main levée. Je t’écoute.'],
  de: ['Okay {name}, ich sehe deine Hand — nur zu.', '{name}, du hattest die Hand oben. Bitte.'],
  fa: ['خب {name}، دستت رو دیدم — بفرما.'],
  ja: ['はい、{name}さん、手が挙がっていましたね。どうぞ。'],
  zh: ['好，{name}，我看到你举手了——请说。'],
};
const HAND_UNANSWERED: Record<string, string[]> = {
  en: [
    'Take your time, {name} — I’ll keep going. Raise your hand again whenever you’re ready.',
    'No rush, {name}. I’ll carry on; put your hand up again when you have it.',
  ],
  es: ['Tranquilo, {name}, sigo. Levanta la mano otra vez cuando quieras.'],
  fr: ['Pas de souci, {name}, je continue. Relève la main quand tu veux.'],
  de: ['Kein Stress, {name}, ich mache weiter. Heb die Hand wieder, wenn du so weit bist.'],
  fa: ['عجله‌ای نیست {name}، من ادامه می‌دم. هر وقت آماده بودی دوباره دست بلند کن.'],
  ja: ['大丈夫ですよ、{name}さん。続けますね。準備ができたらまた手を挙げてください。'],
  zh: ['不急，{name}，我先继续。准备好了再举手。'],
};
const HAND_WITHDRAWN: Record<string, string[]> = {
  en: ['No problem, {name} — moving on.', 'All good, {name}. Back to it.'],
  es: ['Sin problema, {name}. Seguimos.'],
  fr: ['Pas de problème, {name}. On continue.'],
  de: ['Kein Problem, {name}. Weiter geht’s.'],
  fa: ['مشکلی نیست {name}. ادامه می‌دیم.'],
  ja: ['大丈夫です、{name}さん。続けましょう。'],
  zh: ['没关系，{name}。我们继续。'],
};
function forName(table: Record<string, string[]>, name: string, seed: number, language: string) {
  const list = table[language.split('-')[0]?.toLowerCase() ?? 'en'] ?? table.en ?? [];
  const line = list[Math.abs(seed) % list.length] ?? list[0] ?? '{name}.';
  return line.replaceAll('{name}', name);
}
export function callOnHand(name: string, seed: number, language = 'en'): string {
  return forName(CALL_ON, name, seed, language);
}
export function handUnanswered(name: string, seed: number, language = 'en'): string {
  return forName(HAND_UNANSWERED, name, seed, language);
}
export function handWithdrawn(name: string, seed: number, language = 'en'): string {
  return forName(HAND_WITHDRAWN, name, seed, language);
}

/**
 * What the expert says after grading a check-in (ADR-0039): a verdict in a
 * breath, the explanation the lesson already wrote, and on we go. The model
 * used to compose this sentence on every check; a real teacher does not
 * compose "that's it" — they say it. Languages without a table get null,
 * and the room lets the model write the feedback for them as before, rather
 * than an English line in a Spanish lesson.
 *
 * `{explain}` is the check-in's own `explain`, written in the lesson's
 * language when the lesson was; each opener leads into it as a sentence.
 */
type Verdict = 'correct' | 'partial' | 'incorrect';
const CHECK_FEEDBACK: Record<string, Record<Verdict, string[]> & { on: string[] }> = {
  en: {
    correct: ['That’s it.', 'Exactly.', 'Yes — well done.'],
    partial: ['Close — you’re nearly there.', 'Partly, yes.'],
    incorrect: ['Not quite.', 'Not this time.'],
    on: ['Let’s keep going.', 'Moving on.'],
  },
  es: {
    correct: ['Eso es.', 'Exacto.', 'Sí, muy bien.'],
    partial: ['Casi — te falta poco.', 'En parte, sí.'],
    incorrect: ['No exactamente.', 'Esta vez no.'],
    on: ['Sigamos.', 'Continuemos.'],
  },
  fr: {
    correct: ['C’est ça.', 'Exactement.', 'Oui, bravo.'],
    partial: ['Presque — tu y es presque.', 'En partie, oui.'],
    incorrect: ['Pas tout à fait.', 'Pas cette fois.'],
    on: ['Continuons.', 'On avance.'],
  },
  de: {
    correct: ['Genau.', 'Richtig.', 'Ja, sehr gut.'],
    partial: ['Fast — du bist nah dran.', 'Zum Teil, ja.'],
    incorrect: ['Nicht ganz.', 'Diesmal nicht.'],
    on: ['Machen wir weiter.', 'Weiter geht’s.'],
  },
  it: {
    correct: ['Esatto.', 'Proprio così.', 'Sì, bravo.'],
    partial: ['Quasi — ci sei quasi.', 'In parte, sì.'],
    incorrect: ['Non proprio.', 'Non questa volta.'],
    on: ['Andiamo avanti.', 'Continuiamo.'],
  },
  pt: {
    correct: ['Isso mesmo.', 'Exato.', 'Sim, muito bem.'],
    partial: ['Quase — está perto.', 'Em parte, sim.'],
    incorrect: ['Não exatamente.', 'Desta vez não.'],
    on: ['Vamos continuar.', 'Seguimos.'],
  },
  nl: {
    correct: ['Precies.', 'Klopt.', 'Ja, goed gedaan.'],
    partial: ['Bijna — je bent er bijna.', 'Deels, ja.'],
    incorrect: ['Niet helemaal.', 'Deze keer niet.'],
    on: ['We gaan verder.', 'Door.'],
  },
  tr: {
    correct: ['İşte bu.', 'Aynen.', 'Evet, çok iyi.'],
    partial: ['Yaklaştın — az kaldı.', 'Kısmen, evet.'],
    incorrect: ['Tam değil.', 'Bu sefer değil.'],
    on: ['Devam edelim.'],
  },
  ru: {
    correct: ['Именно так.', 'Верно.', 'Да, отлично.'],
    partial: ['Почти — ты близко.', 'Отчасти да.'],
    incorrect: ['Не совсем.', 'В этот раз нет.'],
    on: ['Идём дальше.', 'Продолжим.'],
  },
  fa: {
    correct: ['همین است.', 'دقیقاً.', 'بله، آفرین.'],
    partial: ['نزدیک بود — چیزی نمانده.', 'تا حدی، بله.'],
    incorrect: ['نه دقیقاً.', 'این بار نه.'],
    on: ['ادامه بدهیم.'],
  },
  ar: {
    correct: ['هذا هو.', 'بالضبط.', 'نعم، أحسنت.'],
    partial: ['قريب — كدت تصل.', 'جزئياً، نعم.'],
    incorrect: ['ليس تماماً.', 'ليس هذه المرة.'],
    on: ['لنكمل.'],
  },
  hi: {
    correct: ['बिल्कुल यही।', 'सही।', 'हाँ, बहुत अच्छे।'],
    partial: ['करीब — बस थोड़ा और।', 'कुछ हद तक, हाँ।'],
    incorrect: ['पूरी तरह नहीं।', 'इस बार नहीं।'],
    on: ['आगे बढ़ते हैं।'],
  },
  ja: {
    correct: ['その通りです。', '正解です。', 'はい、よくできました。'],
    partial: ['惜しい — あと少しです。', '部分的には合っています。'],
    incorrect: ['少し違います。', '今回は違いますね。'],
    on: ['続けましょう。'],
  },
  ko: {
    correct: ['바로 그거예요.', '정확해요.', '네, 잘했어요.'],
    partial: ['거의 다 왔어요.', '부분적으로 맞아요.'],
    incorrect: ['조금 달라요.', '이번엔 아니에요.'],
    on: ['계속 가볼게요.'],
  },
  zh: {
    correct: ['就是这样。', '完全正确。', '对，很好。'],
    partial: ['接近了——就差一点。', '部分正确。'],
    incorrect: ['不太对。', '这次不对。'],
    on: ['我们继续。'],
  },
};
export function checkFeedback(
  verdict: Verdict,
  explain: string,
  seed: number,
  language = 'en',
): string | null {
  const table = CHECK_FEEDBACK[language.split('-')[0]?.toLowerCase() ?? 'en'];
  if (!table) return null;
  const pick = (list: string[]) => list[Math.abs(seed) % list.length] ?? list[0] ?? '';
  return [pick(table[verdict]), explain.trim(), pick(table.on)].filter(Boolean).join(' ');
}

export function bridgeBack(seed: number, language = 'en'): string {
  const list = BRIDGES[language.split('-')[0]?.toLowerCase() ?? 'en'] ?? BRIDGES.en ?? [];
  return list[Math.abs(seed) % list.length] ?? list[0] ?? 'Back to it.';
}
