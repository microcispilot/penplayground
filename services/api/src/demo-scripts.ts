import type { LessonEvent, Tone } from '@pen/contracts';
import type { FakeCompletion, FakeScript } from '@pen/llm';

/**
 * Scripted lessons for PEN_LLM_PROVIDER=fake: development, demos and e2e tests
 * run the full loop (planning, teaching, board, interrupts, check-ins, recap)
 * without a model key. Content mirrors the approved mockup's Transformers lesson.
 */
const say = (id: string, text: string, tone: Tone = 'warm'): LessonEvent => ({
  type: 'say',
  id,
  text,
  tone,
});
const write = (
  id: string,
  anchor: string,
  text: string,
  extra: Partial<Extract<LessonEvent, { type: 'board' }>> = {},
): LessonEvent => ({
  type: 'board',
  id,
  anchor,
  op: 'write',
  text,
  lang: '',
  ref: '',
  ref2: '',
  place: 'flow',
  emphasis: 'ink',
  ...extra,
});
const done: LessonEvent = { type: 'done' };

const segments: LessonEvent[][] = [
  [
    say(
      's1',
      "Hi — I'm {{expert}}. Let's start with a sentence, because that's all a language model ever sees.",
    ),
    write('b1', 's1', 'How Transformers work', {
      op: 'title',
      place: 'newline',
      emphasis: 'accent',
    }),
    say('s2', "Six tokens. That's everything the model gets at first.", 'curious'),
    write('b2', 's2', 'the · cat · sat · on · the · mat', { place: 'newline' }),
    say('s3', 'Each token becomes a vector — just a list of numbers the model can move around.'),
    write('b3', 's3', 'token → vector  [0.2, -1.1, 0.7 …]', { place: 'newline' }),
    say(
      's4',
      'Order matters, so we add a position signal. Same word, different place, different vector.',
    ),
    write('b4', 'after:s4', '+ position', { place: 'flow', emphasis: 'accent' }),
    say('s5', 'Jump in whenever something is unclear — I mean it.', 'encouraging'),
    done,
  ],
  [
    say(
      's1',
      "Here's the good part. When the model reads 'sat', it looks back and weighs how much each earlier token matters.",
      'curious',
    ),
    {
      type: 'board',
      id: 'b1',
      anchor: 's1',
      op: 'newpage',
      text: '',
      lang: '',
      ref: '',
      ref2: '',
      place: 'flow',
      emphasis: 'ink',
    },
    write('b2', 's1', 'Attention', { op: 'title', emphasis: 'accent' }),
    say('s2', 'It does that with three projections of every vector: a query, a key, and a value.'),
    {
      type: 'board',
      id: 'b3',
      anchor: 's2',
      op: 'sketch',
      text: 'box q "Query"\nbox k "Key"\nbox v "Value"\nrow\nbox s "score = q·k / √d"\narrow q s\narrow k s',
      lang: '',
      ref: '',
      ref2: '',
      place: 'center',
      emphasis: 'ink',
    },
    say(
      's3',
      'The score is a query dotted with a key, scaled, then softmaxed so the weights add up to one.',
    ),
    write('b4', 's3', 'softmax(scores) → weights, Σ = 1', { place: 'newline' }),
    say(
      's4',
      'Quick one back at you — when "sat" attends to "cat", what is actually being compared?',
      'playful',
    ),
    {
      type: 'check',
      id: 'c1',
      askedBy: 's4',
      options: [
        'The two words as spelled',
        'The query from "sat" against the key from "cat"',
        'Which one came first',
      ],
      expected: 'The query from "sat" against the key from "cat"',
      explain: 'Query from one, key from the other; the dot product is the match score.',
    },
    done,
  ],
  [
    say('s1', 'And it runs twelve of these in parallel. Different heads notice different things.'),
    write('b1', 's1', '12 heads, in parallel', { place: 'newline', emphasis: 'accent' }),
    say(
      's2',
      'Then a small feed-forward layer, and the residual — the original vector is always added back.',
    ),
    write('b2', 's2', 'x + Attention(x) → FFN → x + FFN(…)', { place: 'newline' }),
    say(
      's3',
      "Stack that block thirty-two times and you get a distribution over the next token. 'mat' wins.",
      'playful',
    ),
    write('b3', 's3', '× 32 layers → next token: "mat"', { place: 'newline' }),
    say('s4', "That's the whole machine. Everything else is scale.", 'warm'),
    done,
  ],
];

const answers: Record<string, LessonEvent[]> = {
  'square root': [
    {
      type: 'note',
      language: 'en-US',
      question: 'why ÷ √d ?',
      headline: 'keeps the dot products',
      detail: 'from blowing up as vectors grow',
    },
    say(
      's1',
      'Good one. Without it the dot products get huge as the vectors get longer, and softmax turns into a hard max.',
    ),
    say(
      's2',
      'One token takes everything. Dividing by root d keeps the scores where the gradient still flows.',
    ),
    write('b1', 's2', 'q·k / √d  keeps softmax soft', { place: 'newline', emphasis: 'accent' }),
    say('s3', 'Okay — back to where we were.', 'neutral'),
    done,
  ],
  heads: [
    {
      type: 'note',
      language: 'en-US',
      question: 'do heads differ?',
      headline: 'each head learns',
      detail: 'its own projection',
    },
    say('s1', "No, and that's the whole point. Each head learns its own projection."),
    say(
      's2',
      'One might track subject–verb agreement while another watches punctuation. We concatenate what they all find.',
    ),
    say('s3', 'Right, picking up where we stopped.', 'neutral'),
    done,
  ],
  default: [
    {
      type: 'note',
      language: 'en-US',
      question: 'your question',
      headline: 'short answer',
      detail: 'pinned here for the recap',
    },
    say(
      's1',
      'Good question. The short version: attention is just a weighted average, and the weights come from how well a query matches each key.',
    ),
    say('s2', 'Okay — back to it.', 'neutral'),
    done,
  ],
};

function lastUser(r: { messages: Array<{ role: string; content: string }> }): string {
  return r.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
}

/**
 * The same lesson in Persian. A multilingual product has to be testable in a
 * language that reads right to left, so the fake model teaches this one in
 * Persian whenever the request asks for `fa-IR` (`languageLine` puts the tag
 * in every lesson, turn, recap and card prompt). The English scripts above are
 * untouched; only the matchers decide which is served.
 */
const PERSIAN_SEGMENTS: LessonEvent[][] = [
  [
    say(
      's1',
      'سلام — من {{expert}} هستم. با یک جمله شروع می‌کنیم، چون مدل زبانی فقط همین را می‌بیند.',
    ),
    write('b1', 's1', 'ترنسفورمرها چطور کار می‌کنند', {
      op: 'title',
      place: 'newline',
      emphasis: 'accent',
    }),
    say('s2', 'شش توکن. در آغاز، همهٔ چیزی که مدل دارد همین است.', 'curious'),
    write('b2', 's2', 'گربه روی تشک نشست', { place: 'newline' }),
    say('s3', 'هر توکن به یک بردار تبدیل می‌شود: فهرستی از عددها که مدل می‌تواند جابه‌جا کند.'),
    write('b3', 's3', 'توکن → بردار  [0.2, -1.1, 0.7 …]', { place: 'newline' }),
    say('s4', 'هر جا چیزی روشن نبود، وسط حرفم بپر — جدی می‌گویم.', 'encouraging'),
    done,
  ],
  [
    say(
      's1',
      'حالا بخش اصلی: وقتی مدل «نشست» را می‌خواند، به عقب نگاه می‌کند و وزن هر توکن را می‌سنجد.',
      'curious',
    ),
    write('b1', 's1', 'توجه', { op: 'title', emphasis: 'accent' }),
    say('s2', 'این کار با سه تصویر از هر بردار انجام می‌شود: پرس‌وجو، کلید و مقدار.'),
    write('b2', 's2', 'q·k / √d → softmax', { place: 'newline' }),
    say('s3', 'امتیازها از softmax می‌گذرند تا وزن‌ها جمعشان یک شود.'),
    done,
  ],
  [
    say('s1', 'دوازده سر به موازات هم کار می‌کنند و هر کدام چیز دیگری را می‌بینند.'),
    write('b1', 's1', '۱۲ سر، به موازات هم', { place: 'newline', emphasis: 'accent' }),
    say('s2', 'همین بلوک را سی‌ودو بار روی هم بگذار: توزیع توکن بعدی به دست می‌آید.', 'playful'),
    say('s3', 'همهٔ ماشین همین است. باقی‌اش فقط مقیاس است.', 'warm'),
    done,
  ],
];

/** A Persian question, answered in Persian, with the pinned note in Persian. */
const PERSIAN_ANSWER: LessonEvent[] = [
  {
    type: 'note',
    language: 'fa-IR',
    question: 'چرا بر جذر d تقسیم می‌کنیم؟',
    headline: 'اندازهٔ امتیازها را نگه می‌دارد',
    detail: 'تا softmax به بیشینهٔ سخت تبدیل نشود',
  },
  say('s1', 'سؤال خوبی است. بدون آن، با بلندتر شدن بردارها ضرب داخلی خیلی بزرگ می‌شود.'),
  say(
    's2',
    'آن وقت یک توکن همه‌چیز را برمی‌دارد. تقسیم بر جذر d امتیازها را در محدودهٔ مفید نگه می‌دارد.',
  ),
  write('b1', 's2', 'q·k / √d  softmax را نرم نگه می‌دارد', {
    place: 'newline',
    emphasis: 'accent',
  }),
  say('s3', 'خب — برگردیم به همان جایی که بودیم.', 'neutral'),
  done,
];

/** `languageLine` writes the BCP-47 tag into every prompt; that is what the matchers read. */
function wantsPersian(r: { messages: Array<{ role: string; content: string }> }): boolean {
  return /\bfa(?:-[A-Za-z]{2,4})?\b/.test(lastUser(r));
}

export const demoScripts: {
  scripts: FakeScript[];
  completions: FakeCompletion[];
} = {
  scripts: [
    // Persian first: a request that names `fa-IR` is taught in Persian, segment by segment.
    ...PERSIAN_SEGMENTS.map((events, i) => ({
      match: (r: { purpose: string; messages: Array<{ role: string; content: string }> }) =>
        r.purpose === 'lesson' && wantsPersian(r) && lastUser(r).includes(`SEGMENT ${i + 1}:`),
      events,
      gapMs: 120,
    })),
    {
      match: (r: { purpose: string; messages: Array<{ role: string; content: string }> }) =>
        r.purpose === 'lesson' && wantsPersian(r),
      events: PERSIAN_SEGMENTS[PERSIAN_SEGMENTS.length - 1] ?? [],
      gapMs: 120,
    },
    {
      match: (r: { purpose: string; messages: Array<{ role: string; content: string }> }) =>
        r.purpose === 'turn' && wantsPersian(r),
      events: PERSIAN_ANSWER,
      gapMs: 150,
    },
    ...segments.map((events, i) => ({
      match: (r: { purpose: string; messages: Array<{ role: string; content: string }> }) =>
        r.purpose === 'lesson' && lastUser(r).includes(`SEGMENT ${i + 1}:`),
      events,
      gapMs: 120,
    })),
    { match: (r) => r.purpose === 'lesson', events: segments[2] ?? [], gapMs: 120 },
    {
      match: (r) => r.purpose === 'turn' && /square root|sqrt|√/i.test(lastUser(r)),
      events: answers['square root'] ?? [],
      gapMs: 150,
    },
    {
      match: (r) => r.purpose === 'turn' && /head/i.test(lastUser(r)),
      events: answers.heads ?? [],
      gapMs: 150,
    },
    { match: (r) => r.purpose === 'turn', events: answers.default ?? [], gapMs: 150 },
  ],
  completions: [
    // A Persian lesson plans, recaps and draws its card in Persian; every other
    // request falls through to the English answers below.
    {
      purpose: 'plan',
      match: wantsPersian,
      value: {
        title: 'ترنسفورمرها چطور کار می‌کنند',
        promise: 'یاد بگیرید یک نمودار توجه را بخوانید و بگویید هر تکه چرا آنجاست.',
        segments: [
          {
            title: 'توکن‌ها بردار می‌شوند',
            goal: 'یک جمله را اول به توکن و بعد به بردار ببینید',
            minutes: 1,
            hasCheck: false,
          },
          {
            title: 'توجه: پرس‌وجو، کلید، مقدار',
            goal: 'بگویید امتیاز توجه چه چیزی را مقایسه می‌کند',
            minutes: 1.5,
            hasCheck: false,
          },
          {
            title: 'سرها، باقی‌مانده‌ها و پشته',
            goal: 'ببینید چرا سرها موازی‌اند و بلوک‌ها چطور روی هم می‌نشینند',
            minutes: 1,
            hasCheck: false,
          },
        ],
      },
    },
    {
      purpose: 'recap',
      match: wantsPersian,
      value: {
        points: [
          'توکن‌ها بردار می‌شوند و بعد موقعیت می‌گیرند',
          'توجه یک پرس‌وجو را با همهٔ کلیدها می‌سنجد',
          'softmax امتیازها را به وزن‌هایی تبدیل می‌کند که جمعشان یک است',
          'دوازده سر به موازات هم کار می‌کنند',
          'باقی‌مانده و لایهٔ پیش‌خور، سی‌ودو بار روی هم',
        ],
      },
    },
    {
      purpose: 'session_meta',
      match: wantsPersian,
      value: {
        description: 'ببینید یک جمله چطور بردار می‌شود و توجه چطور توکن بعدی را انتخاب می‌کند.',
        keywords: ['ترنسفورمر', 'توجه', 'توکن'],
        category: 'computing-data',
        // The subject is written in English whatever the session language: it
        // is read by the image model, never by the learner (ADR-0022).
        subject: 'a server rack with glowing processor modules, cool blue light',
        // Persian, and therefore refused by `thumbnailHeadline`: an image
        // model renders Arabic script as decorative marks, so this lesson's
        // picture carries no text at all (ADR-0029). The script does that,
        // not this fixture — the value is here because the model returns one.
        headline: 'ترنسفورمرها چطور کار می‌کنند',
      },
    },
    {
      purpose: 'plan',
      value: {
        title: 'How Transformers work in LLMs',
        promise: 'Learn to read an attention diagram and explain why every piece is there.',
        segments: [
          {
            title: 'Tokens become vectors',
            goal: 'See a sentence as tokens, then as vectors with position',
            minutes: 1,
            hasCheck: false,
          },
          {
            title: 'Attention: query, key, value',
            goal: 'Explain what the attention score compares',
            minutes: 1.5,
            hasCheck: true,
          },
          {
            title: 'Heads, residuals, and the stack',
            goal: 'See why heads run in parallel and how blocks stack',
            minutes: 1,
            hasCheck: false,
          },
        ],
      },
    },
    {
      purpose: 'grade',
      value: {
        verdict: 'correct',
        feedback:
          'Exactly that. Query from one, key from the other, and the dot product is the match score. Nicely done.',
      },
    },
    {
      purpose: 'recap',
      value: {
        points: [
          'Tokens become vectors, then get a position added',
          'Attention scores a query against every key',
          'Softmax turns those scores into weights that sum to one',
          'Twelve heads run in parallel and get concatenated',
          'Residual plus feed-forward, stacked 32 times, gives the next token',
        ],
      },
    },
    { purpose: 'intent', value: { intent: 'question', command: 'none' } },
    {
      // The card copy (ADR-0013), and the thing its picture is pointed at
      // (ADR-0022). The picture itself is the fake image generator's, not a script.
      purpose: 'session_meta',
      value: {
        description:
          'See how a sentence becomes vectors and how attention weighs each earlier token to predict the next one.',
        keywords: ['transformers', 'attention', 'tokens', 'softmax', 'LLM'],
        category: 'computing-data',
        subject: 'a server rack with glowing processor modules, cool blue light',
        headline: 'HOW ATTENTION WORKS',
      },
    },
    {
      purpose: 'intake',
      value: {
        language: 'en-US',
        title: 'How Transformers work in LLMs',
        canonicalTitle: 'How Transformers work in LLMs',
        sourceLanguage: 'en',
      },
    },
    {
      purpose: 'knowledge.outline',
      value: {
        curriculum: ['Tokens', 'Attention', 'Heads', 'Residuals'],
        queries: [
          'transformer attention explained',
          'positional encoding',
          'multi-head attention',
          'residual connections',
          'softmax scaling',
          'query key value',
          'feed forward layer',
          'next token prediction',
        ],
        candidateUrls: [],
      },
    },
    {
      purpose: 'knowledge.evalset',
      value: {
        development: [
          { question: 'What does attention compare?' },
          { question: 'Why scale by the square root of d?' },
          { question: 'What is a token?' },
          { question: 'What do residual connections do?' },
          { question: 'How are heads combined?' },
          { question: 'What does softmax produce?' },
        ],
        negative: [
          { question: 'How do I bake bread?' },
          { question: 'What is the capital of Peru?' },
          { question: 'How do I change a tire?' },
          { question: 'Who won the 1998 World Cup?' },
        ],
      },
    },
    {
      purpose: 'outline',
      value: {
        curriculum: ['Tokens', 'Attention', 'Heads'],
        queries: ['transformer attention explained'],
        candidateUrls: [],
      },
    },
    {
      purpose: 'evalset',
      value: {
        development: [{ question: 'What does attention compare?' }],
        negative: [{ question: 'How do I bake bread?' }],
      },
    },
  ],
};
