import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pack } from './types.js';

/**
 * Packs persist as one JSON file each so compiled topics survive restarts.
 * Small on purpose: the real registry (BUILD-05) replaces this seam.
 */
export interface PackStore {
  list(): Promise<Pack[]>;
  get(packId: string): Promise<Pack | null>;
  put(pack: Pack): Promise<void>;
}

export class MemoryPackStore implements PackStore {
  private readonly packs = new Map<string, Pack>();
  async list(): Promise<Pack[]> {
    return [...this.packs.values()];
  }
  async get(packId: string): Promise<Pack | null> {
    return this.packs.get(packId) ?? null;
  }
  async put(pack: Pack): Promise<void> {
    this.packs.set(pack.packId, pack);
  }
}

export class FilePackStore implements PackStore {
  private cache: Map<string, Pack> | null = null;
  constructor(private readonly dir: string) {}

  private async load(): Promise<Map<string, Pack>> {
    if (this.cache) return this.cache;
    await mkdir(this.dir, { recursive: true });
    const cache = new Map<string, Pack>();
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.pack.json')) continue;
      try {
        const pack = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as Pack;
        cache.set(pack.packId, pack);
      } catch (error) {
        console.warn(`[onten] skipping unreadable pack ${name}:`, error);
      }
    }
    this.cache = cache;
    return cache;
  }
  async list(): Promise<Pack[]> {
    return [...(await this.load()).values()];
  }
  async get(packId: string): Promise<Pack | null> {
    return (await this.load()).get(packId) ?? null;
  }
  async put(pack: Pack): Promise<void> {
    const cache = await this.load();
    cache.set(pack.packId, pack);
    await writeFile(join(this.dir, `${pack.packId}.pack.json`), JSON.stringify(pack));
  }
}
