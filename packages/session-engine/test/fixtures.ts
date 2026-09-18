import type {
  Cue,
  DownstreamAudioHeader,
  Expert,
  LessonEvent,
  ServerMessage,
  SourceDocument,
} from '@pen/contracts';
import type { FakeScript } from '@pen/llm';
import { createOnten, type Onten } from '@pen/onten';
import { SilentSynthesizer, type SpeechSynthesizer, type SynthesisRequest } from '@pen/voice';
import type { RoomTransport } from '../src/transport.js';

/** A persona with a distinct assigned voice per language, so voice switches are observable. */
export const expert: Expert = {
  id: 'ada-okonkwo',
  displayName: 'Ada Okonkwo',
  role: 'Deep Learning Expert',
  tagline: 't',
  biography: 'b',
  specialties: ['transformers'],
  interactionStyle: 'warm',
  aiDisclosure: 'I am Ada, an AI expert.',
  provenance: 'fictional-synthetic',
  portrait: null,
  voiceId: 'af_heart',
  domain: 'computing-data',
  premium: false,
  gender: 'woman',
  voices: { en: 'voice-en', es: 'voice-es', fa: 'voice-fa' },
};

/** Mirrors ExpertVoices.voiceFor: the language's assignment, else English. */
export function voiceFor(language: string): string {
  const lang = language.toLowerCase().split('-')[0] ?? 'en';
  return expert.voices[lang] ?? expert.voices.en ?? 'voice-en';
}

export const CANONICAL_ID = 'en.how-transformers-work-in-llms';

const rights = {
  redistribution: 'allowed' as const,
  authorizedAudiences: ['*'],
  ingestionAllowed: true,
  license: 'CC-BY-4.0',
  attribution: 'Open CS Textbook',
  policyRevision: '1',
  licenseText: '',
};
const doc: SourceDocument = {
  sourceId: 'attention-101',
  url: 'https://example.test/attention',
  title: 'Attention',
  mediaType: 'text/markdown',
  observedAt: Date.now(),
  rights,
  text: `# Tokens and vectors\n\nEach token becomes a vector, a list of numbers the model can move around. Position signals are added so order matters.\n\n# Queries keys and values\n\nAttention computes three projections of every vector: a query, a key and a value. The score is the query dotted with the key, scaled by the square root of d, then softmaxed so weights sum to one.\n\n# Why divide by sqrt d\n\nWithout scaling, dot products grow with vector length and softmax saturates into a hard max, so gradients stop flowing. Dividing by the square root of d keeps the scores in a useful range.\n\n# Multi-head attention\n\nSeveral heads run in parallel; each learns its own projection so one may track agreement while another watches punctuation. Their outputs are concatenated.\n`,
};

/** A fresh Onten with one qualified pack for the transformers topic; returns its pack id too. */
export async function preparedPack(): Promise<{ onten: Onten; packId: string }> {
  const onten = createOnten();
  const c = onten.compiler.startProgressiveCompilation({
    requestId: 'r',
    hostId: 'pen',
    canonicalKnowledgeId: CANONICAL_ID,
    title: 'How Transformers Work in LLMs',
    scope: {
      conceptOrTopicBoundary: 'transformers',
      language: 'en',
      locale: 'en-US',
      domainBoundary: 'computing-data',
    },
    policy: onten.policy.expansion,
  });
  await c.addSource(doc);
  c.finishSources({
    development: [{ question: 'why divide by sqrt d', expectedUnitIds: [] }],
    negative: [{ question: 'bread', expectedUnitIds: [] }],
  });
  const ref = await c.background;
  if (!ref) throw new Error('pack did not qualify');
  return { onten, packId: ref.packId };
}

export class MemoryTransport implements RoomTransport {
  messages: ServerMessage[] = [];
  audio: DownstreamAudioHeader[] = [];
  broadcast(m: ServerMessage) {
    this.messages.push(m);
  }
  send(_p: string, m: ServerMessage) {
    this.messages.push(m);
  }
  broadcastAudio(h: DownstreamAudioHeader) {
    this.audio.push(h);
  }
  cues(): Cue[] {
    return this.messages.flatMap((m) => (m.kind === 'cue' ? [m.cue] : []));
  }
  states() {
    return this.messages.flatMap((m) => (m.kind === 'state' ? [m.state] : []));
  }
  ads() {
    return this.messages.flatMap((m) => (m.kind === 'ad' ? [m] : []));
  }
}

/** Records which voice and speed each sentence was synthesised with; audio itself is silent. */
export class SpySynthesizer implements SpeechSynthesizer {
  readonly id = 'spy';
  readonly requests: Array<{
    text: string;
    voice: string;
    speed: number | null;
    /** Present only for the taught lesson: the mark that says "this may be stored". */
    lesson: SynthesisRequest['lesson'];
  }> = [];
  private readonly inner = new SilentSynthesizer();
  synthesize(request: SynthesisRequest) {
    this.requests.push({
      text: request.text,
      voice: request.voice,
      speed: request.speed ?? null,
      lesson: request.lesson,
    });
    return this.inner.synthesize(request);
  }
  voicesFor(text: string): string[] {
    return this.requests.filter((r) => r.text === text).map((r) => r.voice);
  }
}

export const say = (id: string, text: string): LessonEvent => ({
  type: 'say',
  id,
  text,
  tone: 'warm',
});

/** A lesson script for segment `n` (1-based, as the prompt numbers them) with two sentences. */
export function segmentScript(n: number, gapMs = 2): FakeScript {
  return {
    match: (r) =>
      r.purpose === 'lesson' && r.messages.some((m) => m.content.includes(`SEGMENT ${n}:`)),
    gapMs,
    events: [
      say('s1', `Segment ${n}, first sentence.`),
      say('s2', `Segment ${n}, second sentence.`),
      { type: 'done' },
    ],
  };
}

export function planCompletion(segments: number) {
  return {
    purpose: 'plan',
    value: {
      title: 'How Transformers work',
      promise: 'Learn to read an attention diagram.',
      segments: Array.from({ length: segments }, (_, i) => ({
        title: `Part ${i + 1}`,
        goal: `Goal ${i + 1}`,
        minutes: 1,
        hasCheck: false,
      })),
    },
  };
}

export async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
