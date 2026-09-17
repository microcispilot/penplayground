import { normalizeTopic } from '@pen/onten';
import { describe, expect, it } from 'vitest';
import { matchSeeds, SEEDS, wikipediaArticleToApi, wikipediaSearchExtractUrl } from '../src/seeds.js';

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
      for (const t of seed.targets('topic')) {
        expect(t.url.startsWith('https://')).toBe(true);
        expect(t.title.length).toBeGreaterThan(0);
      }
    }
    expect(SEEDS.find((s) => s.id === 'swift-book')?.targets('x')[0]?.url).toBe('https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/LanguageGuide/TheBasics.md');
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
    const api = wikipediaArticleToApi('https://en.wikipedia.org/wiki/Swift_(programming_language)#History');
    expect(api).not.toBeNull();
    expect(new URL(api ?? '').searchParams.get('titles')).toBe('Swift (programming language)');
    expect(wikipediaArticleToApi('https://en.wikipedia.org/wiki/Special:Random')).toBeNull();
    expect(wikipediaArticleToApi('https://docs.python.org/3/')).toBeNull();
  });
});
