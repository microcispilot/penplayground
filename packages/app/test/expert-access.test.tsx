import type { Expert } from '@pen/contracts';
import { LEGEND_MIN_PLAN, LEGENDS_BY_PLAN } from '@pen/contracts';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Experts } from '../src/screens/Experts.js';
import { Pricing } from '../src/screens/Pricing.js';
import { ANONYMOUS, renderWithApp, SIGNED_IN } from './harness.js';

afterEach(cleanup);

/**
 * What a learner sees of the plan rule (`expert-access.ts`).
 *
 * The rule itself is the server's and is tested there. What matters here is
 * that the UI renders the served `requiredPlan` and nothing of its own: a
 * legend a learner's plan does not include is visible, named, routed to
 * Pricing and not selectable; the same learner on the right plan sees an
 * ordinary card.
 */
function expert(id: string, over: Partial<Expert> = {}): Expert {
  return {
    id,
    displayName: id
      .split('-')
      .map((w) => w[0]?.toUpperCase() + w.slice(1))
      .join(' '),
    role: 'Teacher',
    tagline: 't',
    biography: 'b',
    specialties: ['things'],
    interactionStyle: 'warm',
    aiDisclosure: 'I am an AI expert.',
    provenance: 'fictional-synthetic',
    portrait: { src: `/experts/portraits/${id}-w384.webp`, alt: id },
    voiceId: 'af_heart',
    voices: {},
    domain: 'computing-data',
    premium: false,
    requiredPlan: null,
    gender: 'nonbinary',
    ...over,
  };
}

/** Fifteen modern experts plus Aristotle, so the row has more than it can show. */
function catalog(): Expert[] {
  const modern = Array.from({ length: 15 }, (_, i) => expert(`modern-${i}`));
  return [
    ...modern.slice(0, 4),
    expert('aristotle', {
      displayName: 'Aristotle',
      role: 'Philosophy and Logic Professor',
      provenance: 'historical-recreation',
      domain: 'humanities-languages',
      premium: true,
      requiredPlan: 'standard',
    }),
    expert('isaac-newton', {
      displayName: 'Isaac Newton',
      role: 'Natural Philosopher',
      provenance: 'historical-recreation',
      domain: 'math-science-engineering',
      premium: true,
      requiredPlan: 'professional',
    }),
    ...modern.slice(4),
  ];
}

// The expert cards live on the Experts screen. Home used to carry a row of
// twelve with a "show more" card at the end; the owner removed that section,
// and with it the two tests about the row's shape. What those tests were
// really protecting — who may teach whom, and what a locked card says — is a
// plan rule, not a layout, and it is asserted here against the screen that
// still shows the cards.
const home = (plan: 'free' | 'standard' | 'professional' | 'anonymous') =>
  renderWithApp(<Experts />, {
    participant:
      plan === 'anonymous' ? ANONYMOUS : { ...SIGNED_IN, plan: plan as 'free' | 'standard' },
    routes: { '/api/experts': { experts: catalog() }, '/api/sessions': { sessions: [] } },
  });

const tiles = () => screen.getAllByTestId('expert-tile');

// By name, not by position: "third from the left" was a property of Home's
// row, which no longer exists. Who is locked is a property of the plan.
// A locked card is labelled for assistive technology because it is not a
// button; an unlocked one is a button with a title. Match either, plus the
// visible text, so the lookup does not quietly depend on which it is.
const byName = (name: string) =>
  tiles().find(
    (t) =>
      t.getAttribute('aria-label')?.includes(name) ||
      t.getAttribute('title')?.includes(name) ||
      t.textContent?.includes(name),
  );

describe('a persona the plan does not include', () => {
  it('is shown, named by its plan, and leads to Pricing instead of a session', async () => {
    home('free');
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    const aristotle = byName('Aristotle');
    expect(aristotle?.getAttribute('data-locked')).toBe('true');
    expect(aristotle?.tagName).toBe('A');
    expect(aristotle?.getAttribute('href')).toBe('/pricing');
    expect(aristotle?.getAttribute('aria-label')).toContain('Included with Standard');
    expect(aristotle?.textContent).toContain('Included with Standard');
    // Calm: the plan's name, no padlock, nothing telling the learner what to do.
    expect(aristotle?.textContent).not.toMatch(/upgrade|unlock|locked|required/i);
  });

  it('says Professional for the four at the top tier', async () => {
    home('standard');
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    const newton = tiles().find((t) => t.getAttribute('aria-label')?.includes('Isaac Newton'));
    expect(newton?.getAttribute('data-locked')).toBe('true');
    expect(newton?.textContent).toContain('Included with Professional');
  });
});

describe('a learner whose plan does include them', () => {
  it('sees Aristotle as an ordinary, selectable card on Standard', async () => {
    home('standard');
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    const aristotle = byName('Aristotle');
    expect(aristotle?.getAttribute('aria-label')).toBeNull();
    expect(aristotle?.tagName).toBe('BUTTON');
    expect(aristotle?.getAttribute('data-locked')).toBeNull();
    expect(aristotle?.getAttribute('title')).toBe('Learn with Aristotle');
    expect(screen.queryByText('Included with Standard')).toBeNull();
  });

  it('sees every legend plainly on Professional', async () => {
    home('professional');
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('expert-plan-chip')).toHaveLength(0);
    for (const t of tiles()) expect(t.getAttribute('data-locked')).toBeNull();
  });

  it('treats an anonymous learner as free', async () => {
    home('anonymous');
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    expect(byName('Aristotle')?.getAttribute('data-locked')).toBe('true');
  });
});

describe('the plans say what they include', () => {
  it('counts the legends from the map rather than from a typed number', async () => {
    expect(LEGENDS_BY_PLAN.free).toBe(0);
    expect(LEGENDS_BY_PLAN.standard).toBe(6);
    expect(LEGENDS_BY_PLAN.professional).toBe(Object.keys(LEGEND_MIN_PLAN).length);

    renderWithApp(<Pricing />, {
      routes: { '/api/billing/status': { enabled: false } },
    });
    expect(
      await screen.findByText(/6 legendary teachers, including Socrates and Ada Lovelace/),
    ).toBeTruthy();
    expect(
      screen.getByText(/All 10 legendary teachers, Newton and Shakespeare among them/),
    ).toBeTruthy();
    // Calm: what a plan gives, never what the learner is missing.
    expect(screen.queryByText(/\blocked\b|upgrade required/i)).toBeNull();
  });
});
