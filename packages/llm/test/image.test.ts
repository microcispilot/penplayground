import { inflateSync } from 'node:zlib';
import type { CostLine, StageSample, TelemetryPort } from '@pen/contracts';
import { imagePriceUsd, THUMBNAIL_SIZE } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { FakeImageModel, solidPng } from '../src/image.js';
import { imageErrorCode, withImageTelemetry } from '../src/telemetry.js';
import type { GeneratedImage, ImageModel, ImageRequest } from '../src/types.js';

const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  prompt: 'Design a realistic thumbnail for a YouTube video titled "Reading an ECG strip".',
  size: THUMBNAIL_SIZE,
  quality: 'low',
  purpose: 'session_thumbnail',
  ...over,
});

/** Read the IHDR of a PNG: the bytes must say what we asked for. */
function header(png: Buffer): { width: number; height: number; depth: number; colour: number } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    depth: png[24] ?? 0,
    colour: png[25] ?? 0,
  };
}

describe('solidPng', () => {
  it('writes a real PNG of the asked-for size, with the asked-for colour', () => {
    const png = solidPng(7, 3, [10, 200, 30]);
    expect(header(png)).toEqual({ width: 7, height: 3, depth: 8, colour: 2 });
    // IDAT inflates to `height` scanlines of one filter byte plus width RGB triples.
    const idatLength = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe(3 * (1 + 7 * 3));
    expect(raw[0]).toBe(0);
    expect([raw[1], raw[2], raw[3]]).toEqual([10, 200, 30]);
    // …and it ends where a PNG ends.
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });

  it('holds a full generation-sized image', () => {
    const png = solidPng(THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height, [1, 2, 3]);
    expect(header(png)).toMatchObject(THUMBNAIL_SIZE);
  });
});

describe('FakeImageModel', () => {
  it('answers at the requested size, free and instantly', async () => {
    const { png, usage } = await new FakeImageModel().generate(request());
    expect(header(png)).toMatchObject(THUMBNAIL_SIZE);
    expect(usage.usd).toBe(0);
    expect(usage.model).toBe('fake');
    expect(usage.imageInputTokens).toBe(0);
  });

  it('gives two titles two different pictures, and the same title the same one', async () => {
    const model = new FakeImageModel();
    const a = await model.generate(request({ size: { width: 32, height: 24 } }));
    const b = await model.generate(request({ size: { width: 32, height: 24 } }));
    const c = await model.generate(
      request({ prompt: 'another title', size: { width: 32, height: 24 } }),
    );
    expect(a.png).toEqual(b.png);
    expect(a.png).not.toEqual(c.png);
  });
});

/** An image model whose one call can be made to fail. */
class Stub implements ImageModel {
  readonly id = 'openai:gpt-image-1';
  constructor(private readonly fail?: Error) {}
  async generate(): Promise<GeneratedImage> {
    if (this.fail) throw this.fail;
    return {
      png: solidPng(4, 4, [0, 0, 0]),
      usage: {
        model: 'gpt-image-1',
        inputTokens: 52,
        imageInputTokens: 0,
        cachedTokens: 0,
        outputTokens: 400,
        usd: imagePriceUsd('gpt-image-1', 52, 0, 400),
        firstTokenMs: null,
        totalMs: 10_700,
      },
    };
  }
}

function port(): TelemetryPort & { samples: StageSample[]; costs: CostLine[] } {
  const samples: StageSample[] = [];
  const costs: CostLine[] = [];
  return {
    samples,
    costs,
    sample: (s) => void samples.push(s as StageSample),
    cost: (l) => void costs.push(l),
    error: () => undefined,
  };
}

describe('withImageTelemetry', () => {
  it('records one image stage sample and the two cost lines the generation is priced by', async () => {
    const t = port();
    const result = await withImageTelemetry(new Stub(), t).generate(request());
    expect(t.samples).toHaveLength(1);
    expect(t.samples[0]).toMatchObject({
      stage: 'image',
      ms: 10_700,
      ok: true,
      meta: {
        purpose: 'session_thumbnail',
        model: 'gpt-image-1',
        quality: 'low',
        size: '1536x1024',
        tokensIn: 52,
        tokensOut: 400,
        bytes: result.png.length,
        reused: false,
      },
    });
    expect(t.costs.map((c) => [c.component, c.unit, c.units])).toEqual([
      ['image', 'tokens_in', 52],
      ['image', 'tokens_out', 400],
    ]);
    expect(t.costs.reduce((n, c) => n + c.usd, 0)).toBeCloseTo(result.usage.usd, 9);
  });

  it('records a failure as a sample with a stable code, and rethrows', async () => {
    const t = port();
    const model = withImageTelemetry(new Stub(new Error('IMAGE_NOT_PNG: webp')), t);
    await expect(model.generate(request())).rejects.toThrow(/IMAGE_NOT_PNG/);
    expect(t.samples[0]).toMatchObject({
      stage: 'image',
      ok: false,
      meta: { code: 'IMAGE_NOT_PNG' },
    });
    // Nothing arrived, so nothing is charged.
    expect(t.costs).toEqual([]);
  });
});

describe('imageErrorCode', () => {
  it('keeps a code the endpoint gave us and invents nothing for the rest', () => {
    expect(imageErrorCode(new Error('IMAGE_NO_OUTPUT: 0 images returned'))).toBe('IMAGE_NO_OUTPUT');
    expect(imageErrorCode(new Error('429 Rate limit reached for images'))).toBe('IMAGE_ERROR');
    expect(imageErrorCode('nope')).toBe('IMAGE_ERROR');
  });
});
