import type { KnowledgeObserver } from './types.js';

/**
 * RFC 9309 robots.txt evaluation: the most specific matching group (our
 * product token, else `*`), longest-match rule wins, Allow wins ties,
 * `*` and `$` wildcards. No third-party parser: the rules are short and the
 * semantics are precise.
 */
export interface RobotsRules {
  allows(path: string): boolean;
}

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

export const ALLOW_ALL: RobotsRules = { allows: () => true };
export const DISALLOW_ALL: RobotsRules = { allows: () => false };

function compile(pathPattern: string): RegExp {
  let re = '^';
  for (const ch of pathPattern) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^{}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(re);
}

export function parseRobots(text: string, productToken: string): RobotsRules {
  const token = productToken.toLowerCase();
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === 'allow' || field === 'disallow') && current) {
      if (!value) continue; // empty Disallow = allow everything; empty Allow is a no-op
      let pattern = value;
      try {
        pattern = decodeURIComponent(value);
      } catch {
        pattern = value;
      }
      current.rules.push({ allow: field === 'allow', pattern: compile(pattern), length: pattern.length });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  if (rules.length === 0) return ALLOW_ALL;
  return {
    allows(path: string): boolean {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.pattern.test(path)) continue;
        if (!best || rule.length > best.length || (rule.length === best.length && rule.allow && !best.allow)) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

const ROBOTS_MAX_BYTES = 512 * 1024;

/** Per-host cached robots.txt gate. Unreachable (5xx / network) hosts are treated as disallowed per RFC 9309 §2.3.1.4. */
export class RobotsGate {
  private readonly cache = new Map<string, Promise<RobotsRules>>();

  constructor(
    private readonly opts: {
      fetchImpl: typeof fetch;
      userAgent: string;
      productToken: string;
      timeoutMs: number;
      observer: KnowledgeObserver;
    },
  ) {}

  async isAllowed(url: string, signal: AbortSignal): Promise<boolean> {
    const parsed = new URL(url);
    const rules = await this.rulesFor(parsed.origin, signal);
    return rules.allows(`${parsed.pathname}${parsed.search}`);
  }

  private rulesFor(origin: string, signal: AbortSignal): Promise<RobotsRules> {
    const cached = this.cache.get(origin);
    if (cached) return cached;
    const pending = this.load(origin, signal);
    this.cache.set(origin, pending);
    return pending;
  }

  private async load(origin: string, signal: AbortSignal): Promise<RobotsRules> {
    const url = `${origin}/robots.txt`;
    try {
      const res = await this.opts.fetchImpl(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]),
        headers: { 'user-agent': this.opts.userAgent, accept: 'text/plain,*/*;q=0.5' },
        redirect: 'follow',
      });
      if (res.status >= 500) {
        this.opts.observer.event('knowledge.robots_unavailable', { origin, status: res.status });
        return DISALLOW_ALL;
      }
      if (res.status >= 400) return ALLOW_ALL;
      const text = (await res.text()).slice(0, ROBOTS_MAX_BYTES);
      return parseRobots(text, this.opts.productToken);
    } catch (error) {
      if (signal.aborted) {
        this.cache.delete(origin);
        throw error;
      }
      this.opts.observer.error('knowledge.robots', error, { origin });
      return DISALLOW_ALL;
    }
  }
}
