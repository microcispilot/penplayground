import type { Expert } from '@pen/contracts';
import { LEGEND_MIN_PLAN, LEGENDS_BY_PLAN } from '@pen/contracts';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Home } from '../src/screens/Home.js';
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

const home = (plan: 'free' | 'standard' | 'professional' | 'anonymous') =>
  renderWithApp(<Home />, {
    participant:
      plan === 'anonymous' ? ANONYMOUS : { ...SIGNED_IN, plan: plan as 'free' | 'standard' },
    routes: { '/api/experts': { experts: catalog() }, '/api/sessions': { sessions: [] } },
  });

const tiles = () => screen.getAllByTestId('expert-tile');

describe("Home's expert row", () => {
  it('shows twelve faces and then one card that leads to the rest', async () => {
    home('free');
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    expect(tiles()).toHaveLength(12);
    const more = screen.getByTestId('experts-show-more');
    expect(more.getAttribute('href')).toBe('/experts');
    expect(more.textContent).toContain('Show more');
    // It is the last thing in the row, not a button parked elsewhere.
    const row = screen.getByTestId('experts-row');
    expect(row.lastElementChild).toBe(more);
  });

  it('puts Aristotle third from the left', async () => {
    home('free');
    await waitFor(() => expect(tiles().length).toBe(12));
    expect(tiles()[2]?.getAttribute('aria-label')).toContain('Aristotle');
  });
});

describe('a persona the plan does not include', () => {
  it('is shown, named by its plan, and leads to Pricing instead of a session', async () => {
    home('free');
    await waitFor(() => expect(tiles().length).toBe(12));
    const aristotle = tiles()[2];
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
    await waitFor(() => expect(tiles().length).toBe(12));
    const newton = tiles().find((t) => t.getAttribute('aria-label')?.includes('Isaac Newton'));
    expect(newton?.getAttribute('data-locked')).toBe('true');
    expect(newton?.textContent).toContain('Included with Professional');
  });
});

describe('a learner whose plan does include them', () => {
  it('sees Aristotle as an ordinary, selectable card on Standard', async () => {
    home('standard');
    await waitFor(() => expect(tiles().length).toBe(12));
    const aristotle = tiles()[2];
    expect(aristotle?.getAttribute('aria-label')).toBeNull();
    expect(aristotle?.tagName).toBe('BUTTON');
    expect(aristotle?.getAttribute('data-locked')).toBeNull();
    expect(aristotle?.getAttribute('title')).toBe('Learn with Aristotle');
    expect(screen.queryByText('Included with Standard')).toBeNull();
  });

  it('sees every legend plainly on Professional', async () => {
    home('professional');
    await waitFor(() => expect(tiles().length).toBe(12));
    expect(screen.queryAllByTestId('expert-plan-chip')).toHaveLength(0);
    for (const t of tiles()) expect(t.getAttribute('data-locked')).toBeNull();
  });

  it('treats an anonymous learner as free', async () => {
    home('anonymous');
    await waitFor(() => expect(tiles().length).toBe(12));
    expect(tiles()[2]?.getAttribute('data-locked')).toBe('true');
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
