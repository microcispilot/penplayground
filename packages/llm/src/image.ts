import { deflateSync } from 'node:zlib';
import { imagePriceUsd } from '@pen/contracts';
import OpenAI from 'openai';
import {
  type CostMeter,
  type GeneratedImage,
  type ImageModel,
  type ImageRequest,
  type ImageUsage,
  NOOP_METER,
} from './types.js';

export interface OpenAIImageOptions {
  apiKey: string;
  /** `gpt-image-1`; the id carries the provider prefix like the language model's. */
  model: string;
  baseURL?: string;
  meter?: CostMeter;
  timeoutMs?: number;
}

/**
 * OpenAI Images adapter (`POST /v1/images/generations`).
 *
 * The response is **raster**, and deliberately so: the picture is a
 * photograph, and a photograph has no vector form. `gpt-image-1` returns
 * base64 PNG/JPEG/WebP bytes and nothing else — there is no SVG to ask for,
 * and tracing a photo into paths would only produce a worse drawing, which
 * is the exact thing this replaced. One generation is made per session at the
 * largest size we ever render, and every displayed size is a downscale of
 * those bytes; the bill is per generation, so serving more sizes must never
 * cost more.
 *
 * A generation takes ~11 s at `low`, so this only ever runs in a background
 * job — never on a request or a turn.
 */
export class OpenAIImageModel implements ImageModel {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly meter: CostMeter;

  constructor(private readonly opts: OpenAIImageOptions) {
    this.id = `openai:${opts.model}`;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      // A generation is slow by nature; the SDK's 60 s default aborts a medium one.
      timeout: opts.timeoutMs ?? 180_000,
      maxRetries: 1,
    });
    this.meter = opts.meter ?? NOOP_METER;
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const started = performance.now();
    const response = await this.client.images.generate(
      {
        model: this.opts.model,
        prompt: request.prompt,
        size: `${request.size.width}x${request.size.height}`,
        quality: request.quality,
        n: 1,
      },
      request.signal ? { signal: request.signal } : {},
    );
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error(`IMAGE_NO_OUTPUT: ${response.data?.length ?? 0} images returned`);
    const bytes = Buffer.from(b64, 'base64');
    // The endpoint answers PNG unless asked otherwise; a body that is not one
    // would silently become an unreadable file, so it is caught here.
    if (bytes.subarray(0, 4).toString('hex') !== '89504e47')
      throw new Error(`IMAGE_NOT_PNG: ${response.output_format ?? 'unknown'}`);
    const u = response.usage;
    const inputTokens = u?.input_tokens ?? 0;
    const imageInputTokens = u?.input_tokens_details?.image_tokens ?? 0;
    const outputTokens = u?.output_tokens ?? 0;
    const usage: ImageUsage = {
      model: this.opts.model,
      inputTokens,
      imageInputTokens,
      cachedTokens: 0,
      outputTokens,
      usd: imagePriceUsd(
        this.opts.model,
        inputTokens - imageInputTokens,
        imageInputTokens,
        outputTokens,
      ),
      firstTokenMs: null,
      totalMs: Math.round(performance.now() - started),
    };
    this.meter.record({ ...usage, purpose: request.purpose });
    return { png: bytes, usage };
  }
}

/**
 * Deterministic generator for tests, demos and offline development: a small
 * opaque PNG of the requested size, its colour derived from the prompt so two
 * titles never produce the same bytes. Costs nothing and takes no time.
 */
export class FakeImageModel implements ImageModel {
  readonly id = 'fake';

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    let hash = 0;
    for (const ch of request.prompt) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const rgb: [number, number, number] = [(hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff];
    return {
      png: solidPng(request.size.width, request.size.height, rgb),
      usage: {
        model: 'fake',
        inputTokens: 52,
        imageInputTokens: 0,
        cachedTokens: 0,
        outputTokens: 400,
        usd: 0,
        firstTokenMs: null,
        totalMs: 1,
      },
    };
  }
}

/**
 * A single-colour PNG, written here so the fake provider needs no encoder
 * dependency: one IDAT of `height` scanlines, each a zero filter byte
 * followed by `width` RGB triples, deflated with node's own zlib.
 */
export function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
