import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * The handwriting on the board previews in Settings: two transparent
 * drawings — one in chalk, one in marker — of the same short piece of
 * mathematics, generated once and committed as masks
 * (`packages/app/src/screens/board-handwriting.ts`). The preview tints the
 * mask with the board's own `--color-ink`, so every surface and every chosen
 * colour shows the writing in exactly its ink, and nothing here has a colour
 * of its own.
 *
 *   pnpm --filter @pen/api board:handwriting
 *
 * Bills the platform key (work that belongs to no learner, `KeyOwner`),
 * twice, at `medium` quality — legible handwriting is the whole point.
 * The raw PNGs land in `.pen-data/board-art/` for the owner to look at.
 */
const CONTENT =
  "a teacher's short board work on Pythagoras: a small right triangle sketched with its sides labelled a, b and c, the formula a² + b² = c² written beside it, and one worked line underneath, 3² + 4² = 5². Laid out loosely across the width like real board writing, natural and slightly imperfect, nothing else on the image";

const DRAWINGS = [
  {
    id: 'chalk',
    prompt: `White chalk handwriting on a completely transparent background — only the chalk strokes exist, no board, no background, no frame, no colour other than white. ${CONTENT}. Soft, slightly dusty chalk texture.`,
  },
  {
    id: 'marker',
    prompt: `Black dry-erase marker handwriting on a completely transparent background — only the marker strokes exist, no board, no background, no frame, no colour other than black. ${CONTENT}. Clean, confident marker strokes with a little marker texture.`,
  },
] as const;

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY_PLATFORM ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('set OPENAI_API_KEY_PLATFORM');
  // The images endpoint spoken directly: the SDK lives in @pen/llm, and a
  // one-off asset script is not a reason to add a dependency here.
  const generate = async (prompt: string) => {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        size: '1536x1024',
        quality: 'medium',
        background: 'transparent',
        output_format: 'png',
        n: 1,
      }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) throw new Error(`images ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as {
      data?: Array<{ b64_json?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  };
  const rawDir = join(process.cwd(), '..', '..', '.pen-data', 'board-art');
  mkdirSync(rawDir, { recursive: true });
  const out: string[] = [
    '/**',
    ' * The handwriting on the board previews (Settings), as alpha masks: generated',
    ' * once by `pnpm --filter @pen/api board:handwriting` (gpt-image-1, transparent',
    ' * background), trimmed, downscaled and encoded here so the previews need no',
    ' * asset pipeline on any host. The colour is the board’s own `--color-ink`,',
    ' * applied by CSS; nothing in these bytes is a colour.',
    ' */',
  ];
  for (const d of DRAWINGS) {
    const started = performance.now();
    const res = await generate(d.prompt);
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error(`no image for ${d.id}`);
    const png = Buffer.from(b64, 'base64');
    writeFileSync(join(rawDir, `${d.id}.png`), png);
    // Trim the transparent margin so the writing fills the preview, then a
    // width the preview will never exceed at 2×, encoded with alpha.
    const webp = await sharp(png)
      .trim()
      .resize({ width: 960 })
      .webp({ quality: 82, alphaQuality: 90 })
      .toBuffer();
    writeFileSync(join(rawDir, `${d.id}.webp`), webp);
    const meta = await sharp(webp).metadata();
    out.push(
      `/** ${d.id}: ${meta.width}×${meta.height}, ${webp.length} bytes. */`,
      `export const ${d.id.toUpperCase()}_HANDWRITING = 'data:image/webp;base64,${webp.toString('base64')}';`,
    );
    const u = res.usage;
    console.log(
      `${d.id}: ${Math.round(performance.now() - started)} ms · ${meta.width}×${meta.height} · ${webp.length} bytes webp · tokens in ${u?.input_tokens ?? 0} out ${u?.output_tokens ?? 0}`,
    );
  }
  const target = join(
    process.cwd(),
    '..',
    '..',
    'packages',
    'app',
    'src',
    'screens',
    'board-handwriting.ts',
  );
  writeFileSync(target, `${out.join('\n')}\n`);
  console.log(`wrote ${target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
