import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGAL_CONTACT, LEGAL_UPDATED } from '../src/screens/legal/LegalLayout.js';
import { Privacy } from '../src/screens/legal/Privacy.js';
import { Terms } from '../src/screens/legal/Terms.js';
import { renderWithApp } from './harness.js';

afterEach(cleanup);

/** What the owner asked these pages to say, in the words a reader would look for. */
const TERMS_SECTIONS = [
  'What Pen Playground is',
  'AI limitations and no professional advice',
  'Who can use it, and accounts',
  'Sessions are recorded, and public by default',
  'Plans, ads, and billing',
  'Acceptable use',
  'Your content, generated lessons, and our software',
  'Third-party services',
  'Disclaimers and liability',
  'Changes, ending, and contact',
];

const PRIVACY_SECTIONS = [
  'Who we are',
  'What we process',
  'Why we process it',
  'Who else sees it',
  'How long we keep it',
  'Your choices and rights',
  'Security, international processing, and children',
  'Changes and contact',
];

describe('Terms of Use', () => {
  it('renders every section, in order, with the entity, the date and the contact', () => {
    renderWithApp(<Terms />, { route: '/terms' });
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of Use' })).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(TERMS_SECTIONS.map((t, i) => `${i + 1}. ${t}`));
    expect(document.body.textContent).toContain(`Last updated ${LEGAL_UPDATED}`);
    expect(document.body.textContent).toContain('Microcis, a California limited liability company');
    expect(screen.getAllByRole('link', { name: LEGAL_CONTACT }).length).toBeGreaterThan(0);
  });

  it('says the true things about Pen Playground', () => {
    renderWithApp(<Terms />, { route: '/terms' });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Every expert is an AI.');
    expect(text).toContain('public by default');
    expect(text).toContain('at least 13 years old');
    expect(text).toContain('16 if you are in the European Economic Area');
    expect(text).toContain('Stripe');
    expect(text).toMatch(/skippable video ad/);
  });

  it('says nothing about watching a screen: that is another product', () => {
    renderWithApp(<Terms />, { route: '/terms' });
    const text = document.body.textContent ?? '';
    for (const forbidden of ['screen capture', 'your screen', 'desktop application', 'Simurgh'])
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  it('carries no draft badge and no consent banner', () => {
    renderWithApp(<Terms />, { route: '/terms' });
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const forbidden of [
      'draft',
      'counsel',
      'not effective',
      'accept cookies',
      'we use cookies',
    ])
      expect(text).not.toContain(forbidden);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers a table of contents that names every section', () => {
    renderWithApp(<Terms />, { route: '/terms' });
    const toc = screen.getByRole('navigation', { name: 'On this page' });
    for (const [i, title] of TERMS_SECTIONS.entries())
      expect(within(toc).getByRole('link', { name: `${i + 1}. ${title}` })).toBeTruthy();
  });
});

describe('Privacy Policy', () => {
  it('renders every section, in order, with the date and the contact', () => {
    renderWithApp(<Privacy />, { route: '/privacy' });
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(PRIVACY_SECTIONS.map((t, i) => `${i + 1}. ${t}`));
    expect(document.body.textContent).toContain(`Last updated ${LEGAL_UPDATED}`);
    expect(screen.getAllByRole('link', { name: LEGAL_CONTACT }).length).toBeGreaterThan(0);
  });

  it('names what is actually collected, and who gets it', () => {
    renderWithApp(<Privacy />, { route: '/privacy' });
    const text = document.body.textContent ?? '';
    for (const claim of [
      'anonymous participant id',
      'name, email address and profile picture',
      'New sessions are public by default',
      'Your name is never shown on one',
      'speech recognition happens on your device',
      'PostHog',
      'Sentry',
      'content-free',
      'Stripe',
      'Google Ad Manager',
      'Standard Contractual Clauses',
    ])
      expect(text, claim).toContain(claim);
    expect(text).toContain('We do not sell personal information');
    expect(text).toContain('aged 13 and over');
  });

  it('never claims to watch a screen, and carries no consent banner', () => {
    renderWithApp(<Privacy />, { route: '/privacy' });
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const forbidden of [
      'screen capture',
      'selected display',
      'desktop app',
      'simurgh',
      'draft',
      'counsel',
      'accept cookies',
    ])
      expect(text, forbidden).not.toContain(forbidden);
  });

  it('links to the Terms, and the Terms link back', () => {
    const privacy = renderWithApp(<Privacy />, { route: '/privacy' });
    expect(privacy.container.querySelector('a[href="/terms"]')).toBeTruthy();
    cleanup();
    const terms = renderWithApp(<Terms />, { route: '/terms' });
    expect(terms.container.querySelector('a[href="/privacy"]')).toBeTruthy();
  });
});
