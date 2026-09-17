import { describe, expect, it } from 'vitest';
import { ALLOW_ALL, parseRobots, RobotsGate } from '../src/robots.js';
import { SILENT_KNOWLEDGE_OBSERVER } from '../src/types.js';
import { fakeFetch, recordingObserver } from './helpers.js';

describe('parseRobots (RFC 9309)', () => {
  it('applies the wildcard group with longest-match precedence and Allow winning ties', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /private/\nAllow: /private/public-note\nDisallow: /tmp\n',
      'PenAcademyBot',
    );
    expect(rules.allows('/')).toBe(true);
    expect(rules.allows('/private/x')).toBe(false);
    expect(rules.allows('/private/public-note.html')).toBe(true);
    expect(rules.allows('/tmpfile')).toBe(false);
    expect(rules.allows('/docs')).toBe(true);
  });

  it('prefers the group for our product token over *', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: penacademybot\nDisallow: /nope\n',
      'PenAcademyBot/0.1',
    );
    expect(rules.allows('/anything')).toBe(true);
    expect(rules.allows('/nope/x')).toBe(false);
  });

  it('supports * and $ wildcards and empty Disallow', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*\nDisallow:\n',
      'bot',
    );
    expect(rules.allows('/a/b.pdf')).toBe(false);
    expect(rules.allows('/a/b.pdf?x=1')).toBe(true);
    expect(rules.allows('/search?q=1')).toBe(false);
    expect(rules.allows('/docs')).toBe(true);
  });

  it('allows everything when the file has no rules', () => {
    expect(parseRobots('# nothing here\n', 'bot')).toBe(ALLOW_ALL);
    expect(parseRobots('User-agent: other\nDisallow: /\n', 'bot').allows('/')).toBe(true);
  });
});

describe('RobotsGate', () => {
  const opts = {
    userAgent: 'PenAcademyBot/0.1',
    productToken: 'PenAcademyBot',
    timeoutMs: 1000,
    observer: SILENT_KNOWLEDGE_OBSERVER,
  };

  it('fetches robots.txt once per origin and treats 404 as allow-all', async () => {
    const log: Array<{ url: string; at: number }> = [];
    const gate = new RobotsGate({
      ...opts,
      fetchImpl: fakeFetch(
        {
          'https://a.example.org/robots.txt': {
            body: 'User-agent: *\nDisallow: /x/\n',
            type: 'text/plain',
          },
        },
        log,
      ),
    });
    const signal = new AbortController().signal;
    expect(await gate.isAllowed('https://a.example.org/x/1', signal)).toBe(false);
    expect(await gate.isAllowed('https://a.example.org/y/1', signal)).toBe(true);
    expect(await gate.isAllowed('https://b.example.org/x/1', signal)).toBe(true);
    expect(log.map((l) => l.url)).toEqual([
      'https://a.example.org/robots.txt',
      'https://b.example.org/robots.txt',
    ]);
  });

  it('treats 5xx and network errors as disallow and reports them', async () => {
    const observer = recordingObserver();
    const failing: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://down.example.org')) return new Response('oops', { status: 503 });
      throw new TypeError('fetch failed');
    };
    const gate = new RobotsGate({ ...opts, observer, fetchImpl: failing });
    const signal = new AbortController().signal;
    expect(await gate.isAllowed('https://down.example.org/a', signal)).toBe(false);
    expect(await gate.isAllowed('https://gone.example.org/a', signal)).toBe(false);
    expect(observer.events.some((e) => e.name === 'knowledge.robots_unavailable')).toBe(true);
    expect(observer.errors.some((e) => e.area === 'knowledge.robots')).toBe(true);
  });
});
