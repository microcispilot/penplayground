import {
  AssemblyAIRecognizer,
  DeepgramRecognizer,
  type SpeechRecognizerFactory,
  WsRelayRecognizer,
} from '@pen/voice';
import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * Server-side STT per deployment (ADR-0004). `browser` means clients transcribe
 * on-device and the API answers upstream audio with STT_UNAVAILABLE.
 */
export function createRecognizer(cfg: Config): SpeechRecognizerFactory | null {
  switch (cfg.PEN_STT_PROVIDER) {
    case 'browser':
      return null;
    case 'deepgram':
      if (!cfg.DEEPGRAM_API_KEY)
        throw new Error('PEN_STT_PROVIDER=deepgram requires DEEPGRAM_API_KEY');
      return new DeepgramRecognizer({ apiKey: cfg.DEEPGRAM_API_KEY });
    case 'assemblyai':
      if (!cfg.ASSEMBLYAI_API_KEY)
        throw new Error('PEN_STT_PROVIDER=assemblyai requires ASSEMBLYAI_API_KEY');
      return new AssemblyAIRecognizer({ apiKey: cfg.ASSEMBLYAI_API_KEY });
    case 'ws-relay':
      if (!cfg.PEN_STT_RELAY_URL)
        throw new Error('PEN_STT_PROVIDER=ws-relay requires PEN_STT_RELAY_URL');
      logger.warn(
        { url: cfg.PEN_STT_RELAY_URL },
        'PEN_STT_PROVIDER=ws-relay: transcribing through the Simurgh STT host (explicit opt-in; not for public traffic)',
      );
      return new WsRelayRecognizer({ baseUrl: cfg.PEN_STT_RELAY_URL });
  }
}
