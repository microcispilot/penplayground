import type { CodeLine } from './shapes/props.js';

/**
 * Code highlighting for `code-block`. Shiki's fine-grained core with the
 * JavaScript regex engine (no WASM, ~small) and `github-light`, whose
 * foreground is mapped to the paper ink token so code sits on the paper like
 * everything else. Languages load lazily from a curated map; anything else
 * renders as plain ink rather than failing the op.
 */
export interface CodeHighlighter {
  highlight(code: string, lang: string): Promise<CodeLine[]>;
}

export function plainLines(code: string): CodeLine[] {
  return code.split('\n').map((line) => (line ? [{ t: line, c: null, b: false, i: false }] : []));
}

/** Language aliases the model is likely to emit → shiki ids. */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  'shell-script': 'bash',
  yml: 'yaml',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'c',
  kt: 'kotlin',
  objc: 'objective-c',
  'objective-c': 'objective-c',
  md: 'markdown',
  htm: 'html',
  plaintext: 'text',
  txt: 'text',
  text: 'text',
};

type LangLoader = () => Promise<{ default: unknown }>;

/** Curated so the bundler can code-split each grammar. */
const LANGS: Record<string, LangLoader> = {
  swift: () => import('shiki/langs/swift.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
};

export function resolveLang(lang: string): string | null {
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  const id = ALIASES[key] ?? key;
  if (id === 'text') return null;
  return LANGS[id] ? id : null;
}

export function createShikiHighlighter(): CodeHighlighter {
  type Core = Awaited<ReturnType<typeof import('shiki/core')['createHighlighterCore']>>;
  let corePromise: Promise<Core> | null = null;
  const loaded = new Set<string>();
  let themeFg = '#24292e';

  const core = (): Promise<Core> => {
    if (corePromise) return corePromise;
    corePromise = Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
      .then(([shiki, js]) =>
        shiki.createHighlighterCore({
          engine: js.createJavaScriptRegexEngine({ forgiving: true }),
          themes: [import('shiki/themes/github-light.mjs')],
          langs: [],
        }),
      )
      .then((h) => {
        themeFg = (h.getTheme('github-light').fg ?? themeFg).toLowerCase();
        return h;
      })
      .catch((err: unknown) => {
        corePromise = null;
        throw err;
      });
    return corePromise;
  };

  return {
    async highlight(code, lang) {
      const id = resolveLang(lang);
      if (!id) return plainLines(code);
      try {
        const h = await core();
        if (!loaded.has(id)) {
          const loader = LANGS[id];
          if (!loader) return plainLines(code);
          await h.loadLanguage(loader() as never);
          loaded.add(id);
        }
        const tokens = h.codeToTokensBase(code, { lang: id, theme: 'github-light' });
        return tokens.map((line) =>
          line.map((tok) => {
            const c = tok.color?.toLowerCase() ?? null;
            const fontStyle = tok.fontStyle ?? 0;
            return {
              t: tok.content,
              c: c === null || c === themeFg ? null : c,
              b: (fontStyle & 2) !== 0,
              i: (fontStyle & 1) !== 0,
            };
          }),
        );
      } catch (err) {
        console.warn('[board] highlighting failed, rendering plain code', err);
        return plainLines(code);
      }
    },
  };
}
