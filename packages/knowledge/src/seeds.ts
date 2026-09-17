import type { Transform } from './types.js';

/**
 * Curated allowlist of licensed open sources that can be fetched directly.
 * Every URL below was verified (HTTP 200) on 2026-09-16; licences are in
 * `rights.ts`. Patterns run against the normalised topic (lower-case, learner
 * phrasing stripped). Chapter order is teaching order so the first documents
 * to land are the ones a beginner lesson needs.
 */
export interface Seed {
  id: string;
  pattern: RegExp;
  /** Human label for status lines: "Reading the Swift language guide…". */
  label: string;
  /** Lower runs first among matched seeds. */
  priority: number;
  /** Only used when no other seed matched (generic fallback). */
  fallback?: boolean;
  targets(topic: string, language: string): SeedTarget[];
}

export interface SeedTarget {
  url: string;
  title: string;
  transform: Transform;
  /** Declared API endpoint (robots.txt exempt; see fetcher). */
  api?: boolean;
}

const SWIFT_BOOK =
  'https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/LanguageGuide';
const SWIFT_CHAPTERS: Array<[string, string]> = [
  ['TheBasics', 'The Basics'],
  ['BasicOperators', 'Basic Operators'],
  ['StringsAndCharacters', 'Strings and Characters'],
  ['CollectionTypes', 'Collection Types'],
  ['ControlFlow', 'Control Flow'],
  ['Functions', 'Functions'],
  ['Closures', 'Closures'],
  ['Enumerations', 'Enumerations'],
  ['ClassesAndStructures', 'Structures and Classes'],
  ['Properties', 'Properties'],
  ['Methods', 'Methods'],
  ['Subscripts', 'Subscripts'],
  ['Inheritance', 'Inheritance'],
  ['Initialization', 'Initialization'],
  ['Deinitialization', 'Deinitialization'],
  ['OptionalChaining', 'Optional Chaining'],
  ['ErrorHandling', 'Error Handling'],
  ['Concurrency', 'Concurrency'],
  ['Macros', 'Macros'],
  ['TypeCasting', 'Type Casting'],
  ['NestedTypes', 'Nested Types'],
  ['Extensions', 'Extensions'],
  ['Protocols', 'Protocols'],
  ['Generics', 'Generics'],
  ['OpaqueTypes', 'Opaque and Boxed Protocol Types'],
  ['AutomaticReferenceCounting', 'Automatic Reference Counting'],
  ['MemorySafety', 'Memory Safety'],
  ['AccessControl', 'Access Control'],
  ['AdvancedOperators', 'Advanced Operators'],
];

const RUST_BOOK = 'https://raw.githubusercontent.com/rust-lang/book/main/src';
const RUST_CHAPTERS: Array<[string, string]> = [
  ['ch01-01-installation', 'Installation'],
  ['ch01-02-hello-world', 'Hello, World!'],
  ['ch01-03-hello-cargo', 'Hello, Cargo!'],
  ['ch02-00-guessing-game-tutorial', 'Programming a Guessing Game'],
  ['ch03-01-variables-and-mutability', 'Variables and Mutability'],
  ['ch03-02-data-types', 'Data Types'],
  ['ch03-03-how-functions-work', 'Functions'],
  ['ch03-04-comments', 'Comments'],
  ['ch03-05-control-flow', 'Control Flow'],
  ['ch04-01-what-is-ownership', 'What Is Ownership?'],
  ['ch04-02-references-and-borrowing', 'References and Borrowing'],
  ['ch04-03-slices', 'The Slice Type'],
  ['ch05-01-defining-structs', 'Defining and Instantiating Structs'],
  ['ch05-02-example-structs', 'An Example Program Using Structs'],
  ['ch05-03-method-syntax', 'Method Syntax'],
  ['ch06-01-defining-an-enum', 'Defining an Enum'],
  ['ch06-02-match', 'The match Control Flow Construct'],
  ['ch06-03-if-let', 'Concise Control Flow with if let'],
  ['ch07-01-packages-and-crates', 'Packages and Crates'],
  ['ch07-02-defining-modules-to-control-scope-and-privacy', 'Defining Modules'],
  ['ch08-01-vectors', 'Storing Lists of Values with Vectors'],
  ['ch08-02-strings', 'Storing UTF-8 Encoded Text with Strings'],
  ['ch08-03-hash-maps', 'Storing Keys with Associated Values in Hash Maps'],
  ['ch09-01-unrecoverable-errors-with-panic', 'Unrecoverable Errors with panic!'],
  ['ch09-02-recoverable-errors-with-result', 'Recoverable Errors with Result'],
  ['ch10-01-syntax', 'Generic Data Types'],
  ['ch10-02-traits', 'Traits: Defining Shared Behavior'],
  ['ch10-03-lifetime-syntax', 'Validating References with Lifetimes'],
];

const PYTHON_TUTORIAL = 'https://docs.python.org/3/tutorial';
const PYTHON_PAGES: Array<[string, string]> = [
  ['introduction', 'An Informal Introduction to Python'],
  ['controlflow', 'More Control Flow Tools'],
  ['datastructures', 'Data Structures'],
  ['modules', 'Modules'],
  ['inputoutput', 'Input and Output'],
  ['errors', 'Errors and Exceptions'],
  ['classes', 'Classes'],
  ['stdlib', 'Brief Tour of the Standard Library'],
  ['stdlib2', 'Brief Tour of the Standard Library — Part II'],
  ['venv', 'Virtual Environments and Packages'],
];

const MDN = 'https://raw.githubusercontent.com/mdn/content/main/files/en-us';
const MDN_JS_LEARN: Array<[string, string]> = [
  ['what_is_javascript', 'What is JavaScript?'],
  ['a_first_splash', 'A first splash into JavaScript'],
  ['variables', 'Storing the information you need — Variables'],
  ['math', 'Basic math in JavaScript — numbers and operators'],
  ['strings', 'Handling text — strings in JavaScript'],
  ['useful_string_methods', 'Useful string methods'],
  ['arrays', 'Arrays'],
  ['conditionals', 'Making decisions in your code — conditionals'],
  ['loops', 'Looping code'],
  ['functions', 'Functions — reusable blocks of code'],
  ['build_your_own_function', 'Build your own function'],
  ['return_values', 'Function return values'],
  ['events', 'Introduction to events'],
  ['object_basics', 'JavaScript object basics'],
  ['json', 'Working with JSON'],
];
const MDN_JS_GUIDE: Array<[string, string]> = [
  ['grammar_and_types', 'Grammar and types'],
  ['control_flow_and_error_handling', 'Control flow and error handling'],
  ['loops_and_iteration', 'Loops and iteration'],
  ['functions', 'Functions'],
  ['expressions_and_operators', 'Expressions and operators'],
  ['working_with_objects', 'Working with objects'],
  ['using_classes', 'Using classes'],
  ['using_promises', 'Using promises'],
  ['closures', 'Closures'],
  ['modules', 'JavaScript modules'],
];
const MDN_CSS: Array<[string, string]> = [
  ['what_is_css', 'What is CSS?'],
  ['getting_started', 'Getting started with CSS'],
  ['basic_selectors', 'Basic CSS selectors'],
  ['box_model', 'The box model'],
  ['values_and_units', 'CSS values and units'],
  ['sizing', 'Sizing items in CSS'],
  ['backgrounds_and_borders', 'Backgrounds and borders'],
  ['handling_conflicts', 'Handling conflicts'],
  ['combinators', 'Combinators'],
  ['pseudo_classes_and_elements', 'Pseudo-classes and pseudo-elements'],
];
const MDN_HTML: Array<[string, string]> = [
  ['basic_html_syntax', 'Basic HTML syntax'],
  ['webpage_metadata', "What's in the head? Web page metadata"],
  ['headings_and_paragraphs', 'Headings and paragraphs in HTML'],
  ['emphasis_and_importance', 'Emphasis and importance'],
  ['lists', 'Lists'],
  ['creating_links', 'Creating links'],
  ['structuring_documents', 'Structuring documents'],
  ['html_images', 'HTML images'],
  ['html_table_basics', 'HTML table basics'],
  ['html_forms', 'Forms and buttons in HTML'],
];

function fromPairs(
  base: string,
  pairs: Array<[string, string]>,
  suffix: string,
  transform: Transform,
): SeedTarget[] {
  return pairs.map(([slug, title]) => ({ url: `${base}/${slug}${suffix}`, title, transform }));
}

export const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

/** Wikipedia's Action API for a language edition (en, de, ja, …). */
export function wikipediaApi(language = 'en'): string {
  const lang = /^[a-z]{2,3}$/.test(language) ? language : 'en';
  return `https://${lang}.wikipedia.org/w/api.php`;
}

/** Action API query for the best-matching article's plain-text extract (one request). */
export function wikipediaSearchExtractUrl(topic: string, language = 'en'): string {
  const q = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: topic,
    gsrlimit: '1',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    format: 'json',
    formatversion: '2',
  });
  return `${wikipediaApi(language)}?${q.toString()}`;
}

/** Action API query for a named article's plain-text extract. */
export function wikipediaTitleExtractUrl(title: string, language = 'en'): string {
  const q = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    format: 'json',
    formatversion: '2',
  });
  return `${wikipediaApi(language)}?${q.toString()}`;
}

export const SEEDS: Seed[] = [
  {
    id: 'swift-book',
    pattern: /^(?!.*\btaylor\b).*\bswift(ui)?\b/,
    label: 'the Swift language guide',
    priority: 0,
    targets: () => fromPairs(SWIFT_BOOK, SWIFT_CHAPTERS, '.md', 'docc'),
  },
  {
    id: 'rust-book',
    pattern: /\brust(lang|acean)?\b|\bcargo\b/,
    label: 'the Rust book',
    priority: 0,
    targets: () => fromPairs(RUST_BOOK, RUST_CHAPTERS, '.md', 'mdbook'),
  },
  {
    id: 'python-tutorial',
    pattern: /\bpython\b|\bpandas\b|\bnumpy\b|\bpip\b|\bpy\b/,
    label: 'the Python tutorial',
    priority: 0,
    targets: () => fromPairs(PYTHON_TUTORIAL, PYTHON_PAGES, '.html', 'none'),
  },
  {
    id: 'mdn-javascript',
    pattern:
      /\b(javascript|js|ecmascript|es6|dom|node(js)?|react|vue|svelte|front-?end|web (dev|development|apps?))\b/,
    label: 'MDN Web Docs',
    priority: 1,
    targets: () => [
      ...fromPairs(`${MDN}/learn_web_development/core/scripting`, MDN_JS_LEARN, '/index.md', 'mdn'),
      ...fromPairs(`${MDN}/web/javascript/guide`, MDN_JS_GUIDE, '/index.md', 'mdn'),
    ],
  },
  {
    id: 'mdn-css',
    pattern:
      /\bcss\b|\bstyl(e|ing) (a |the )?(web|page)|\bflexbox\b|\bcss grid\b|\bweb design\b|\bfront-?end\b/,
    label: 'MDN Web Docs',
    priority: 1,
    targets: () =>
      fromPairs(`${MDN}/learn_web_development/core/styling_basics`, MDN_CSS, '/index.md', 'mdn'),
  },
  {
    id: 'mdn-html',
    pattern: /\bhtml\b|\bweb ?pages?\b|\bfront-?end\b|\bweb (dev|development)\b/,
    label: 'MDN Web Docs',
    priority: 1,
    targets: () =>
      fromPairs(
        `${MDN}/learn_web_development/core/structuring_content`,
        MDN_HTML,
        '/index.md',
        'mdn',
      ),
  },
  {
    id: 'wikipedia',
    pattern: /\S/,
    label: 'Wikipedia',
    priority: 5,
    fallback: true,
    targets: (topic, language) => [
      {
        url: wikipediaSearchExtractUrl(topic, language),
        title: `Wikipedia: ${topic}`,
        transform: 'wikipedia-extract',
        api: true,
      },
    ],
  },
];

/** Seeds whose pattern matches the normalised topic; fallbacks only when nothing else matched. */
export function matchSeeds(normalizedTopic: string, seeds: Seed[] = SEEDS): Seed[] {
  const topic = normalizedTopic.toLowerCase().trim();
  const primary = seeds.filter((s) => !s.fallback && s.pattern.test(topic));
  if (primary.length > 0) return primary.sort((a, b) => a.priority - b.priority);
  return seeds
    .filter((s) => s.fallback && s.pattern.test(topic))
    .sort((a, b) => a.priority - b.priority);
}

export interface CanonicalSource {
  url: string;
  transform: Transform;
  api: boolean;
}

const SWIFT_CHAPTER_BY_SLUG = new Map(SWIFT_CHAPTERS.map(([file]) => [file.toLowerCase(), file]));

/**
 * Rendered-site URLs the model or a search engine hands us are mapped to the
 * licensed markdown source we already know how to read (and dedupe against
 * the seeds): docs.swift.org (a JS-rendered DocC site) → swift-book raw,
 * doc.rust-lang.org/book → rust-lang/book raw, developer.mozilla.org → mdn
 * content raw, Wikipedia articles → the Action API extract.
 */
export function canonicalizeSourceUrl(url: string): CanonicalSource | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  if (host === 'docs.swift.org') {
    const m = /^\/swift-book\/documentation\/the-swift-programming-language\/([a-z0-9-]+)$/i.exec(
      path,
    );
    const slug = m?.[1]?.toLowerCase();
    if (!slug) return null;
    if (slug === 'guidedtour') {
      return {
        url: 'https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/GuidedTour/GuidedTour.md',
        transform: 'docc',
        api: false,
      };
    }
    const chapter = SWIFT_CHAPTER_BY_SLUG.get(slug);
    return chapter ? { url: `${SWIFT_BOOK}/${chapter}.md`, transform: 'docc', api: false } : null;
  }
  if (host === 'doc.rust-lang.org') {
    const m = /^(?:\/(?:stable|beta|nightly))?\/book\/((?:ch|appendix)[a-z0-9-]+)\.html$/i.exec(
      path,
    );
    return m?.[1]
      ? { url: `${RUST_BOOK}/${m[1].toLowerCase()}.md`, transform: 'mdbook', api: false }
      : null;
  }
  if (host === 'developer.mozilla.org') {
    const m = /^\/en-us\/docs\/([a-z0-9_/.:-]+)$/i.exec(path);
    return m?.[1]
      ? {
          url: `${MDN}/${m[1].toLowerCase().replace(/\/+$/, '')}/index.md`,
          transform: 'mdn',
          api: false,
        }
      : null;
  }
  const wiki = wikipediaArticleToApi(url);
  return wiki ? { url: wiki, transform: 'wikipedia-extract', api: true } : null;
}

/** Rewrite a canonical Wikipedia article URL to the API extract endpoint; null for anything else. */
export function wikipediaArticleToApi(url: string): string | null {
  const m = /^https?:\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/([^#?]+)/.exec(url);
  if (!m?.[1]) return null;
  let title: string;
  try {
    title = decodeURIComponent(m[1]);
  } catch {
    title = m[1];
  }
  if (/^(Special|File|Category|Talk|Help|Portal|Template|Wikipedia):/i.test(title)) return null;
  return wikipediaTitleExtractUrl(title.replace(/_/g, ' '));
}
