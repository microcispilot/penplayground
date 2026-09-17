import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The production bundle (`pnpm build` → `dist/main.js`) must boot on plain node with
 * every runtime-located dependency (PGlite wasm, fastText model, Playwright driver)
 * resolving from node_modules. This is what the Docker image runs; a package that
 * esbuild inlines by mistake fails here instead of on the host.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'pen-bundle-'));

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('production bundle', () => {
  it('builds and boots, answering /api/health with render and language detection ready', async () => {
    const built = await run('pnpm', ['build'], root);
    expect(built.code, built.out).toBe(0);
    expect(existsSync(join(root, 'dist', 'main.js'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'drizzle', 'meta', '_journal.json'))).toBe(true);

    const port = 4300 + Math.floor(Math.random() * 500);
    const child = spawn('node', ['dist/main.js'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PEN_PORT: String(port),
        PEN_JWT_SECRET: 'bundle-test-secret-bundle-test-secret',
        PEN_LLM_PROVIDER: 'fake',
        PEN_TTS_PROVIDER: 'silent',
        DATABASE_URL: 'pglite://memory',
        PEN_DATA_DIR: dataDir,
        PEN_MIGRATIONS_DIR: join(root, 'dist', 'drizzle'),
        PEN_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    try {
      const deadline = Date.now() + 30_000;
      let health: Record<string, unknown> | null = null;
      while (Date.now() < deadline && !health) {
        health = await fetch(`http://127.0.0.1:${port}/api/health`)
          .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
          .catch(() => null);
        if (!health) await new Promise((r) => setTimeout(r, 300));
      }
      expect(health, log).not.toBeNull();
      expect(health).toMatchObject({ ok: true, llm: 'fake', tts: 'silent', render: true });
      // fastText loads at boot; a missing wasm/model aborts the process and shows up here.
      expect(log).not.toMatch(/ENOENT|Aborted|Cannot find|ERR_MODULE_NOT_FOUND/);
    } finally {
      child.kill('SIGTERM');
    }
  }, 120_000);
});
