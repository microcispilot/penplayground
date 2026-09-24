/**
 * Delivery cues: how a sentence is *said*, as distinct from what it says
 * (ADR-0047).
 *
 * The model writes a lesson for the ear, and a good speaker does more than
 * read: they lean on one word, take a beat before the point, drop their
 * voice for an aside, laugh when something is funny. Fish's S2.1 family
 * takes exactly these as natural-language cues in square brackets, placed
 * where the change happens (docs.fish.audio, "Emotion Control"). The model
 * is allowed a small, named vocabulary of them inline; the sentence's
 * overall tone (`SayEvent.tone`) becomes a sentence-level cue at the front.
 *
 * Two texts leave this module for every sentence: `text`, with every cue
 * removed, which is what captions, the recap, the transcript and the board
 * ever see; and `spoken`, with the vetted cues kept, which is what the voice
 * receives. A bracket the vocabulary does not name is stripped from both —
 * the model may not invent delivery — and a cue that is not the caller's
 * engine's business is stripped by that engine.
 */

/** Sentence-level tones the model chooses from (`Tone` in @pen/contracts). */
export type DeliveryTone = 'neutral' | 'warm' | 'curious' | 'serious' | 'playful' | 'encouraging';

/**
 * The inline cues the model may write, and what each is for. All of them
 * are in Fish's documented list for S2.1 (`[emphasis]`, `[break]`,
 * `[long-break]`, `[soft tone]`, `[whispering]`, `[chuckling]`, `[laughing]`,
 * `[sighing]`), chosen for a teacher: stress, timing, an aside, a laugh.
 */
export const DELIVERY_CUES = [
  'emphasis',
  'break',
  'long-break',
  'soft tone',
  'whispering',
  'chuckling',
  'laughing',
  'sighing',
] as const;
export type DeliveryCue = (typeof DELIVERY_CUES)[number];

/**
 * How each tone is said. Fish reads free-form descriptions; these are its
 * own documented emotion words where one fits (`curious`, `confident`,
 * `delighted`, `empathetic`) and plain adjectives where none does. `neutral`
 * is no cue at all: the voice's own manner, which is already a teacher's.
 */
const TONE_CUES: Record<DeliveryTone, string | null> = {
  neutral: null,
  warm: 'warm',
  curious: 'curious',
  serious: 'serious and confident',
  playful: 'playful and delighted',
  encouraging: 'encouraging and empathetic',
};

const ANY_BRACKET = /\[([^[\]\n]{1,40})\]/g;
const KNOWN = new Set<string>(DELIVERY_CUES);

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

/**
 * Split one sentence into what is shown and what is said. Unknown brackets
 * go from both; a known cue stays only in `spoken`. Case and surrounding
 * spaces inside the brackets are forgiven, so `[ Emphasis ]` is `[emphasis]`.
 */
export function splitDelivery(text: string): { text: string; spoken: string } {
  const spoken = text.replace(ANY_BRACKET, (_, inner: string) => {
    const cue = inner.trim().toLowerCase();
    return KNOWN.has(cue) ? `[${cue}]` : ' ';
  });
  const shown = spoken.replace(ANY_BRACKET, ' ');
  return { text: tidy(shown), spoken: tidy(spoken) };
}

/** Every delivery cue removed: for an engine that cannot read them. */
export function withoutDelivery(text: string): string {
  return tidy(text.replace(ANY_BRACKET, ' '));
}

/** The sentence as Fish S2.1 should receive it: the tone in front, the inline cues kept. */
export function deliveryText(text: string, tone?: string): string {
  const { spoken } = splitDelivery(text);
  const cue = tone ? (TONE_CUES[tone as DeliveryTone] ?? null) : null;
  return cue && spoken ? `[${cue}] ${spoken}` : spoken;
}
