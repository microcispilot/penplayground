import { FileLessonMemo, MemoryLessonMemo } from './lesson-memo.js';
import { FilePackStore, MemoryPackStore, type PackStore } from './pack-store.js';
import { PEN_HOST_POLICY } from './policy.js';
import { MockCompiler } from './progressive.js';
import { MockRegistry } from './registry.js';
import { MockContextRuntime } from './runtime.js';
import type { HostContextPolicy, LessonMemo, OntenCompiler, OntenRegistry } from './types.js';

export interface Onten {
  store: PackStore;
  registry: OntenRegistry;
  compiler: OntenCompiler;
  memo: LessonMemo;
  policy: HostContextPolicy;
  /** One runtime per session: configure() with that session's packs. */
  newRuntime(): MockContextRuntime;
}

export function createOnten(opts: { dataDir?: string; policy?: HostContextPolicy } = {}): Onten {
  const store = opts.dataDir ? new FilePackStore(`${opts.dataDir}/packs`) : new MemoryPackStore();
  const memo = opts.dataDir ? new FileLessonMemo(opts.dataDir) : new MemoryLessonMemo();
  const policy = opts.policy ?? PEN_HOST_POLICY;
  return {
    store,
    memo,
    policy,
    registry: new MockRegistry(store, memo),
    compiler: new MockCompiler(store),
    newRuntime: () => new MockContextRuntime(store),
  };
}
