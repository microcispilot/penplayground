import type { Expert, PlanCode, Platform, VoiceEngine } from '@pen/contracts';
import { VOICE_ENGINES } from '@pen/contracts';
import type { SpeechSynthesizer } from '@pen/voice';
import type { ExpertVoices } from '../voices.js';

/**
 * The voice of one session (ADR-0048): which engine speaks, through which
 * synthesizer (its own, behind its own store of taught lessons), and which
 * voice each expert has on it. A binding is made once, when the session is
 * created, and handed to the room whole. The room never asks which engine
 * it is on; nothing inside it can change engine; two sessions on different
 * engines share nothing but the interface.
 */
export interface VoiceBinding {
  readonly engine: VoiceEngine;
  readonly synthesizer: SpeechSynthesizer;
  /** The expert's voice on this engine for a locale, falling back to English, then to a stable pick. */
  voiceFor(expert: Pick<Expert, 'id' | 'gender' | 'voices'>, locale: string): string;
}

export interface VoiceEngineParts {
  readonly synthesizer: SpeechSynthesizer;
  readonly voices: ExpertVoices;
}

export interface VoiceWho {
  plan: PlanCode;
  platform: Platform;
  anonymous?: boolean;
  participantId?: string;
}

export interface VoiceServiceOptions {
  /** The engines this deployment can speak with: the ones it holds keys for. */
  engines: Partial<Record<VoiceEngine, VoiceEngineParts>>;
  /** The policy: the `voice_engine` setting resolved for one learner (`FeatureStore.setting`). */
  policy: (who: VoiceWho) => string;
  /** Said once per session whose choice could not be honoured, and never silently. */
  onFallback?: (event: { wanted: string; used: VoiceEngine; who: VoiceWho }) => void;
}

/**
 * Turns the policy's answer into a binding. The policy may name an engine
 * this server holds no key for — a document written for production, read by
 * a checkout with one key — and then the session still speaks: with the
 * first engine that exists, in the catalogue's order, and the fallback is
 * reported so it is a fact in the logs rather than a surprise in a lesson.
 */
export class VoiceService {
  private readonly engines: ReadonlyMap<VoiceEngine, VoiceBinding>;

  constructor(private readonly o: VoiceServiceOptions) {
    const engines = new Map<VoiceEngine, VoiceBinding>();
    for (const engine of VOICE_ENGINES) {
      const parts = o.engines[engine];
      if (!parts) continue;
      engines.set(engine, {
        engine,
        synthesizer: parts.synthesizer,
        voiceFor: (expert, locale) => parts.voices.voiceFor(expert, locale),
      });
    }
    if (engines.size === 0) throw new Error('VOICE_ENGINES_EMPTY');
    this.engines = engines;
  }

  /** The engines this server can speak with, in the catalogue's order. */
  available(): readonly VoiceEngine[] {
    return VOICE_ENGINES.filter((e) => this.engines.has(e));
  }

  /** The binding for one session, decided now and never revisited. */
  bind(who: VoiceWho): VoiceBinding {
    const wanted = this.o.policy(who);
    const chosen = this.engines.get(wanted as VoiceEngine);
    if (chosen) return chosen;
    const used = this.available()[0] as VoiceEngine;
    this.o.onFallback?.({ wanted, used, who });
    return this.engines.get(used) as VoiceBinding;
  }

  /** A specific engine, for work that is not a session's — a probe, an admin preview. */
  engine(engine: VoiceEngine): VoiceBinding | null {
    return this.engines.get(engine) ?? null;
  }
}
