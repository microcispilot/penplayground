import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRecognizer } from '../src/stt.js';

const base = { PEN_JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' };

describe('createRecognizer', () => {
  it('is null for browser STT', () => {
    expect(createRecognizer(loadConfig({ ...base, PEN_STT_PROVIDER: 'browser' }))).toBeNull();
  });

  it('builds each provider from its key and fails fast without one', () => {
    expect(
      createRecognizer(loadConfig({ ...base, PEN_STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'k' }))
        ?.id,
    ).toBe('deepgram:nova-3');
    expect(
      createRecognizer(
        loadConfig({ ...base, PEN_STT_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'k' }),
      )?.id,
    ).toBe('assemblyai:universal-3-5-pro');
    expect(
      createRecognizer(
        loadConfig({ ...base, PEN_STT_PROVIDER: 'ws-relay', PEN_STT_RELAY_URL: 'ws://h:8320' }),
      )?.id,
    ).toBe('ws-relay');
    expect(() => createRecognizer(loadConfig({ ...base, PEN_STT_PROVIDER: 'deepgram' }))).toThrow(
      /DEEPGRAM_API_KEY/,
    );
    expect(() => createRecognizer(loadConfig({ ...base, PEN_STT_PROVIDER: 'assemblyai' }))).toThrow(
      /ASSEMBLYAI_API_KEY/,
    );
    expect(() => createRecognizer(loadConfig({ ...base, PEN_STT_PROVIDER: 'ws-relay' }))).toThrow(
      /PEN_STT_RELAY_URL/,
    );
  });
});
