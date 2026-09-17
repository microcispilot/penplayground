import type { BoardEvent } from '@pen/contracts';

/**
 * A sample cue sequence for a visual check. Play it through a BoardController:
 *
 *   for (const [op, paceMs] of DEMO_SCRIPT) await board.execute(op, { paceMs }).done;
 *
 * `paceMs` mimics the anchored sentence's duration (null = natural speed).
 */
function op(
  id: string,
  partial: Partial<Omit<BoardEvent, 'type' | 'id'>> & Pick<BoardEvent, 'op'>,
): BoardEvent {
  return {
    type: 'board',
    id,
    anchor: 'now',
    text: '',
    lang: '',
    ref: '',
    ref2: '',
    place: 'flow',
    emphasis: 'ink',
    ...partial,
  };
}

export const DEMO_SCRIPT: ReadonlyArray<readonly [BoardEvent, number | null]> = [
  [op('b1', { op: 'title', text: 'Attention, in one page', place: 'newline' }), 3200],
  [op('b2', { op: 'write', text: 'the cat sat on the mat', place: 'newline' }), 2800],
  [
    op('b3', { op: 'write', text: 'each token → a vector', place: 'newline', emphasis: 'accent' }),
    2400,
  ],
  [
    op('b4', {
      op: 'sketch',
      place: 'center',
      text: [
        'box q "Query"',
        'box k "Key"',
        'box v "Value"',
        'row',
        'box s "Score = q·k / √d"',
        'arrow q s',
        'arrow k s',
      ].join('\n'),
    }),
    9000,
  ],
  [op('b5', { op: 'highlight', ref: 's', emphasis: 'accent' }), 1200],
  [op('b6', { op: 'arrow', ref: 'v', ref2: 's', text: 'weights' }), 1600],
  [
    op('b7', {
      op: 'code',
      lang: 'swift',
      place: 'newline',
      text: [
        'let scores = q.dot(k) / sqrt(Double(d))',
        'let weights = softmax(scores)',
        'let out = weights * v',
      ].join('\n'),
    }),
    6500,
  ],
  [
    op('b8', {
      op: 'markdown',
      place: 'column',
      text: [
        '**Why ÷ √d?**',
        '',
        '- keeps dot products small',
        '- softmax stays soft',
        '- gradients keep flowing',
      ].join('\n'),
    }),
    5000,
  ],
  [
    op('b9', { op: 'write', text: 'stack it 32×', place: 'below', ref: 'b8', emphasis: 'muted' }),
    null,
  ],
  [op('b10', { op: 'erase', ref: 'b5' }), null],
  [op('b11', { op: 'newpage' }), null],
  [op('b12', { op: 'title', text: 'Next: multi-head' }), null],
];

export const DEMO_NOTE = {
  question: 'why divide by √d?',
  headline: 'Scale keeps softmax soft',
  detail: 'Without it dot products grow with d and softmax saturates.',
} as const;
