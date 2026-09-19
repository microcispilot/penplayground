import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THUMBNAIL_SIZE } from '@pen/contracts';
import { solidPng } from '@pen/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileThumbnailImageCache, THUMBNAIL_CACHE_DIR } from '../src/thumbnail-cache.js';

/**
 * The per-lesson picture cache (ADR-0021). A generation costs ~$0.016, so the
 * second session on a topic must get the first one's bytes and pay nothing —
 * and must be able to say exactly what that saved.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pen-thumb-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const png = (r: number) => solidPng(64, 48, [r, 120, 200]);
const key = (scope: string, titleDigest = 'title-1') => ({ scope, titleDigest });
const entry = (r: number) => ({
  png: png(r),
  usd: 0.01626,
  model: 'gpt-image-1',
  quality: 'low' as const,
});

describe('the picture cache', () => {
  it('returns the exact bytes and the exact price of the generation it holds', async () => {
    const cache = new FileThumbnailImageCache(dir);
    expect(await cache.get(key('en.transformers|beginner|ada|en-US'))).toBeNull();
    const value = entry(10);
    await cache.put(key('en.transformers|beginner|ada|en-US'), value);
    const hit = await cache.get(key('en.transformers|beginner|ada|en-US'));
    expect(hit?.png).toEqual(value.png);
    expect(hit?.usd).toBe(0.01626);
    expect(hit?.model).toBe('gpt-image-1');
    expect(hit?.quality).toBe('low');
    expect(cache.size()).toBe(1);
  });

  it('misses when the title changed, because the title is the whole prompt', async () => {
    const cache = new FileThumbnailImageCache(dir);
    await cache.put(key('scope-a', 'title-1'), entry(10));
    expect(await cache.get(key('scope-a', 'title-1'))).not.toBeNull();
    expect(await cache.get(key('scope-a', 'title-2'))).toBeNull();
  });

  it('keeps one picture per scope: a regenerated one replaces the old bytes', async () => {
    const cache = new FileThumbnailImageCache(dir);
    await cache.put(key('scope-a', 'title-1'), entry(10));
    await cache.put(key('scope-a', 'title-2'), entry(200));
    expect(cache.size()).toBe(1);
    expect((await cache.get(key('scope-a', 'title-2')))?.png).toEqual(png(200));
  });

  it('survives a scope with characters a file name cannot hold', async () => {
    const cache = new FileThumbnailImageCache(dir);
    const nasty = '../../etc/passwd|beginner|ada|en-US';
    await cache.put(key(nasty), entry(10));
    expect(await cache.get(key(nasty))).not.toBeNull();
    // Everything it wrote is inside its own directory.
    expect(readdirSync(join(dir, THUMBNAIL_CACHE_DIR)).length).toBe(2);
  });

  it('drops the oldest pictures when the byte cap is passed', async () => {
    const one = png(10).length;
    const cache = new FileThumbnailImageCache(dir, one * 2 + 1);
    for (const [i, scope] of ['a', 'b', 'c'].entries()) {
      await cache.put(key(scope), entry(10 + i));
      // mtime has one-second resolution on some filesystems; keep the order unambiguous.
      await new Promise((r) => setTimeout(r, 12));
    }
    expect(cache.size()).toBe(2);
    expect(await cache.get(key('a'))).toBeNull();
    expect(await cache.get(key('c'))).not.toBeNull();
  });

  it('is a cold cache, never a failure, when an entry is corrupt or half-written', async () => {
    const cache = new FileThumbnailImageCache(dir);
    await cache.put(key('scope-a'), entry(10));
    const files = readdirSync(join(dir, THUMBNAIL_CACHE_DIR));
    const json = files.find((f) => f.endsWith('.json')) as string;
    writeFileSync(join(dir, THUMBNAIL_CACHE_DIR, json), 'not json');
    expect(await cache.get(key('scope-a'))).toBeNull();

    const other = new FileThumbnailImageCache(dir);
    await other.put(key('scope-b'), entry(20));
    const pngFile = readdirSync(join(dir, THUMBNAIL_CACHE_DIR)).find(
      (f) => f.endsWith('.png') && f !== `${json.slice(0, -5)}.png`,
    ) as string;
    writeFileSync(join(dir, THUMBNAIL_CACHE_DIR, pngFile), 'not a png');
    expect(await other.get(key('scope-b'))).toBeNull();
  });

  it('reads back what another process wrote', async () => {
    await new FileThumbnailImageCache(dir).put(key('scope-a'), entry(10));
    expect(await new FileThumbnailImageCache(dir).get(key('scope-a'))).not.toBeNull();
  });

  it('holds a full-size generation without truncating it', async () => {
    const cache = new FileThumbnailImageCache(dir);
    const full = solidPng(THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height, [10, 20, 30]);
    await cache.put(key('scope-full'), { ...entry(10), png: full });
    expect((await cache.get(key('scope-full')))?.png.length).toBe(full.length);
  });
});
