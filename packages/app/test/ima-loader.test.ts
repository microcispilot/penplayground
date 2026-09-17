import { afterEach, describe, expect, it } from 'vitest';
import { IMA_SDK_URL, type ImaNamespace, loadIma, resetImaLoader } from '../src/ads/ima.js';

interface FakeScript {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  removed: number;
  remove(): void;
}

function fakeDocument() {
  const scripts: FakeScript[] = [];
  const doc = {
    createElement: () => {
      const s: FakeScript = {
        src: '',
        async: false,
        onload: null,
        onerror: null,
        removed: 0,
        remove() {
          this.removed += 1;
        },
      };
      scripts.push(s);
      return s;
    },
    head: { appendChild: () => undefined },
  } as unknown as Document;
  return { doc, scripts };
}

const fakeIma = { AdEvent: { Type: {} } } as unknown as ImaNamespace;

afterEach(() => resetImaLoader());

describe('IMA loader', () => {
  it('injects the SDK script once, lazily, and resolves the namespace on load', async () => {
    const { doc, scripts } = fakeDocument();
    const win: { google?: { ima?: ImaNamespace } } = {};
    const p1 = loadIma({ timeoutMs: 2000, doc, win });
    const p2 = loadIma({ timeoutMs: 2000, doc, win });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(IMA_SDK_URL);
    expect(scripts[0]?.async).toBe(true);
    win.google = { ima: fakeIma };
    scripts[0]?.onload?.();
    await expect(p1).resolves.toBe(fakeIma);
    await expect(p2).resolves.toBe(fakeIma);
    // Already on the page: no second script.
    await expect(loadIma({ timeoutMs: 2000, doc, win })).resolves.toBe(fakeIma);
    expect(scripts).toHaveLength(1);
  });

  it('rejects with PEN_AD_SDK_BLOCKED when the script errors, and lets the next ad retry', async () => {
    const { doc, scripts } = fakeDocument();
    const win: { google?: { ima?: ImaNamespace } } = {};
    const p = loadIma({ timeoutMs: 2000, doc, win });
    scripts[0]?.onerror?.();
    await expect(p).rejects.toMatchObject({ code: 'PEN_AD_SDK_BLOCKED' });
    expect(scripts[0]?.removed).toBe(1);
    loadIma({ timeoutMs: 2000, doc, win }).catch(() => undefined);
    expect(scripts).toHaveLength(2);
  });

  it('rejects with PEN_AD_SDK_TIMEOUT when nothing happens within the deadline', async () => {
    const { doc } = fakeDocument();
    let fire: (() => void) | null = null;
    const p = loadIma({
      timeoutMs: 2000,
      doc,
      win: {},
      setTimeout: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimeout: () => undefined,
    });
    (fire as (() => void) | null)?.();
    await expect(p).rejects.toMatchObject({ code: 'PEN_AD_SDK_TIMEOUT' });
  });

  it('treats a script that loads without google.ima (a stub from a blocker) as blocked', async () => {
    const { doc, scripts } = fakeDocument();
    const p = loadIma({ timeoutMs: 2000, doc, win: {} });
    scripts[0]?.onload?.();
    await expect(p).rejects.toMatchObject({ code: 'PEN_AD_SDK_BLOCKED' });
  });
});
