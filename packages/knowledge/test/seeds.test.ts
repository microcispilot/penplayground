import { normalizeTopic } from '@pen/onten';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeSourceUrl,
  matchSeeds,
  SEEDS,
  wikipediaArticleToApi,
  wikipediaSearchExtractUrl,
} from '../src/seeds.js';

describe('matchSeeds', () => {
  const ids = (topic: string) => matchSeeds(normalizeTopic(topic)).map((s) => s.id);

  it('picks the curated repositories for seeded languages', () => {
    expect(ids('I want to learn Swift fundamentals')).toEqual(['swift-book']);
    expect(ids('rust ownership and borrowing')).toEqual(['rust-book']);
    expect(ids('python basics')).toEqual(['python-tutorial']);
    expect(ids('javascript promises')).toEqual(['mdn-javascript']);
    expect(ids('css flexbox')).toEqual(['mdn-css']);
    expect(ids('front-end web development')).toEqual(['mdn-javascript', 'mdn-css', 'mdn-html']);
  });

  it('falls back to Wikipedia only when no curated seed matches, and never confuses Taylor Swift with Swift', () => {
    expect(ids('taylor swift songwriting')).toEqual(['wikipedia']);
    expect(ids('bond pricing')).toEqual(['wikipedia']);
    expect(ids('')).toEqual([]);
  });

  it('every static seed target is https and carries a title', () => {
    for (const seed of SEEDS) {
      for (const t of seed.targets('topic', 'en')) {
        expect(t.url.startsWith('https://')).toBe(true);
        expect(t.title.length).toBeGreaterThan(0);
      }
    }
    expect(SEEDS.find((s) => s.id === 'swift-book')?.targets('x', 'en')[0]?.url).toBe(
      'https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/LanguageGuide/TheBasics.md',
    );
  });
});

describe('wikipedia helpers', () => {
  it('builds an Action API extract query for a search', () => {
    const url = new URL(wikipediaSearchExtractUrl('rust ownership'));
    expect(url.origin + url.pathname).toBe('https://en.wikipedia.org/w/api.php');
    expect(url.searchParams.get('gsrsearch')).toBe('rust ownership');
    expect(url.searchParams.get('explaintext')).toBe('1');
  });

  it('rewrites article URLs to the extract endpoint and ignores special pages', () => {
    const api = wikipediaArticleToApi(
      'https://en.wikipedia.org/wiki/Swift_(programming_language)#History',
    );
    expect(api).not.toBeNull();
    expect(new URL(api ?? '').searchParams.get('titles')).toBe('Swift (programming language)');
    expect(wikipediaArticleToApi('https://en.wikipedia.org/wiki/Special:Random')).toBeNull();
    expect(wikipediaArticleToApi('https://docs.python.org/3/')).toBeNull();
  });
});

describe('canonicalizeSourceUrl', () => {
  it('maps rendered doc sites to the licensed markdown source we already read', () => {
    expect(
      canonicalizeSourceUrl(
        'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/thebasics/',
      ),
    ).toEqual({
      url: 'https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/LanguageGuide/TheBasics.md',
      transform: 'docc',
      api: false,
    });
    expect(
      canonicalizeSourceUrl(
        'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/guidedtour',
      )?.url,
    ).toBe(
      'https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/GuidedTour/GuidedTour.md',
    );
    expect(
      canonicalizeSourceUrl(
        'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/optionals',
      ),
    ).toBeNull();
    expect(
      canonicalizeSourceUrl('https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html'),
    ).toEqual({
      url: 'https://raw.githubusercontent.com/rust-lang/book/main/src/ch04-01-what-is-ownership.md',
      transform: 'mdbook',
      api: false,
    });
    expect(
      canonicalizeSourceUrl('https://doc.rust-lang.org/stable/book/ch04-03-slices.html')?.url,
    ).toBe('https://raw.githubusercontent.com/rust-lang/book/main/src/ch04-03-slices.md');
    expect(
      canonicalizeSourceUrl(
        'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures',
      ),
    ).toEqual({
      url: 'https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/javascript/guide/closures/index.md',
      transform: 'mdn',
      api: false,
    });
    expect(
      canonicalizeSourceUrl('https://en.wikipedia.org/wiki/Rust_(programming_language)'),
    ).toMatchObject({
      transform: 'wikipedia-extract',
      api: true,
    });
    expect(canonicalizeSourceUrl('https://docs.python.org/3/tutorial/classes.html')).toBeNull();
    expect(canonicalizeSourceUrl('nonsense')).toBeNull();
  });
});
