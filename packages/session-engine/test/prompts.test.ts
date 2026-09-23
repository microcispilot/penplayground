import { describe, expect, it } from 'vitest';
import { answerMessages, evidenceGuidance } from '../src/prompts.js';

/**
 * What the expert is told about the edge of its evidence (ADR-0035): each
 * status gets its own instruction, none of them invites a guess, and the
 * sufficient case adds nothing.
 */
const plan = {
  title: 'How Transformers work',
  promise: 'p',
  band: 'beginner' as const,
  seconds: 600,
  segments: [{ index: 0, title: 'Attention', goal: 'g', seconds: 300, hasCheck: false }],
};

function prompt(status: string): string {
  const messages = answerMessages({
    system: 'sys',
    plan,
    segment: plan.segments[0] as (typeof plan.segments)[number],
    question: 'Why divide by the square root of d?',
    askedBy: 'Sam',
    recentSpeech: ['Attention scores a query against every key.'],
    modelContext: '{}',
    status,
    language: 'en-US',
  });
  return messages.map((m) => m.content).join('\n');
}

describe('evidenceGuidance', () => {
  it('says something different for partial, conflict and stale, and nothing for sufficient', () => {
    const lines = ['partial', 'conflict', 'stale'].map(evidenceGuidance);
    expect(new Set(lines).size).toBe(3);
    for (const line of lines) expect(line.length).toBeGreaterThan(40);
    expect(evidenceGuidance('sufficient')).toBe('');
  });

  it('never invites a guess: every line names what to say is not there', () => {
    expect(evidenceGuidance('partial')).toMatch(/does not cover/);
    expect(evidenceGuidance('partial')).toMatch(/rather than fill the gap/);
    expect(evidenceGuidance('conflict')).toMatch(/disagree/);
    expect(evidenceGuidance('conflict')).toMatch(/do not pretend they agree/);
    expect(evidenceGuidance('stale')).toMatch(/out of date/);
    expect(evidenceGuidance('stale')).toMatch(/Do not invent/);
  });

  it('reaches the prompt the model sees, by status', () => {
    expect(prompt('partial')).toContain('covers only part of this');
    expect(prompt('conflict')).toContain('The sources disagree');
    expect(prompt('stale')).toContain('may be out of date');
    expect(prompt('sufficient')).not.toMatch(/partial|disagree|out of date/);
  });
});
