import { FEATURE_NAMES } from '@pen/contracts';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionPage } from '../src/screens/SessionPage.js';
import { ANONYMOUS, renderWithApp, SIGNED_IN } from './harness.js';

/**
 * The watch page (ADR-0044): who sees what.
 *
 * A visitor gets the lesson — the expert as a channel row, the actions, the
 * description, the thread and the way in to comment — and none of the host's
 * controls. A host with an account gets their questions and Delete; a paid
 * host gets Make private as well. There is one Share, and it is a sheet.
 */
afterEach(cleanup);

const ID = 's_page_0000001';
const expert = {
  id: 'juno',
  displayName: 'Juno Park',
  role: 'Systems Mentor',
  tagline: 'Systems, explained.',
  biography: 'A mentor.',
  specialties: ['Swift'],
  interactionStyle: 'calm',
  aiDisclosure: 'An AI expert.',
  provenance: 'fictional-synthetic',
  portrait: null,
  voiceId: 'v1',
  voices: {},
  domain: 'computing-data',
  premium: false,
  requiredPlan: null,
  gender: 'nonbinary',
};
const session = (hostId: string) => ({
  id: ID,
  topic: 'Swift',
  title: 'Swift fundamentals',
  promise: '',
  expertId: 'juno',
  hostId,
  hostName: hostId ? 'Host' : '',
  band: 'beginner',
  domain: 'computing-data',
  visibility: 'public',
  startedAt: Date.now() - 86_400_000,
  endedAt: Date.now() - 86_000_000,
  durationMs: 400_000,
  segments: 3,
  questions: 0,
  recap: ['Values and types', 'Optionals'],
  views: 12,
  thumbnail: null,
  canonicalId: null,
  language: 'en-US',
  description: 'A first pass over Swift.',
  keywords: [],
  likes: 2,
  guests: 0,
});
const features = (plan: 'free' | 'standard', anonymous: boolean) => ({
  plan,
  platform: 'web',
  anonymous,
  features: Object.fromEntries(
    FEATURE_NAMES.map((name) => [
      name,
      name === 'history' || name === 'lists' || name === 'comments'
        ? !anonymous
        : name === 'session_visibility' || name === 'session_download'
          ? plan !== 'free'
          : true,
    ]),
  ),
});
const routes = (hostId: string, who: ReturnType<typeof features>) => ({
  [`/api/sessions/${ID}`]: { session: session(hostId), live: false, state: null, expert },
  [`/api/sessions/${ID}/ledger`]: { session: session(hostId), entries: [], expert },
  [`/api/sessions/${ID}/comments`]: {
    comments: [
      {
        id: 'c_one',
        sessionId: ID,
        authorId: 'p_someone',
        authorName: 'Grace',
        authorAvatarUrl: null,
        body: 'Lovely explanation.',
        createdAt: Date.now() - 3_600_000,
      },
    ],
    total: 1,
    nextBefore: null,
  },
  '/api/sessions': { sessions: [] },
  '/api/experts': { experts: [expert] },
  '/api/me/features': who,
});

function mount(
  participant: typeof ANONYMOUS | null,
  hostId: string,
  who: ReturnType<typeof features>,
) {
  return renderWithApp(
    <Routes>
      <Route path="/sessions/:id" element={<SessionPage />} />
    </Routes>,
    { participant, route: `/sessions/${ID}`, routes: routes(hostId, who) },
  );
}

describe('the watch page', () => {
  it('shows a visitor the lesson, the thread and the way in — and no controls of the host’s', async () => {
    // The API strips the host from a record it hands to anyone else.
    mount(ANONYMOUS, '', features('free', true));
    await waitFor(() =>
      expect(screen.getByTestId('session-expert').textContent).toContain('Juno Park'),
    );
    expect(screen.getByTestId('session-description').textContent).toContain('12 views');
    expect(screen.getByTestId('session-description').textContent).toContain('What was covered');
    expect(screen.queryByTestId('owner-controls')).toBeNull();
    expect(screen.queryByText('Questions you asked')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    // One Share, as a sheet with the public link; no card, no "Open share page".
    expect(screen.getAllByTestId('session-share')).toHaveLength(1);
    expect(screen.queryByText('Open share page')).toBeNull();
    fireEvent.click(screen.getByTestId('session-share'));
    await waitFor(() =>
      expect((screen.getByTestId('share-url') as HTMLInputElement).value).toBe(
        `http://api.test/s/${ID}`,
      ),
    );
    // The thread is read; writing is the sign-in door.
    await waitFor(() => expect(screen.getByTestId('comments-count').textContent).toBe('1 comment'));
    expect(screen.getByTestId('comment-list').textContent).toContain('Lovely explanation.');
    expect(screen.queryByTestId('comment-composer')).toBeNull();
    expect(screen.getByTestId('comment-signin').textContent).toContain('Sign in to comment');
    expect(screen.queryByTestId('comment-delete')).toBeNull();
  });

  it('gives a paid host their questions, Delete and Make private, and a composer', async () => {
    mount(SIGNED_IN, SIGNED_IN.id, features('standard', false));
    await waitFor(() => expect(screen.getByTestId('owner-controls')).toBeTruthy());
    expect(screen.getByTestId('visibility-toggle').textContent).toBe('Make private');
    expect(screen.getByTestId('delete-session')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Your questions' })).toBeTruthy();
    expect(screen.getByText('Questions you asked')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('comment-composer')).toBeTruthy());
    expect(screen.queryByTestId('comment-signin')).toBeNull();
    // The host may delete anyone's comment.
    await waitFor(() => expect(screen.getByTestId('comment-delete')).toBeTruthy());
  });

  it('gives a free host Delete and their questions, but not the visibility control', async () => {
    const free = { ...SIGNED_IN, plan: 'free' as const };
    mount(free, free.id, features('free', false));
    await waitFor(() => expect(screen.getByTestId('owner-controls')).toBeTruthy());
    expect(screen.getByTestId('delete-session')).toBeTruthy();
    expect(screen.queryByTestId('visibility-toggle')).toBeNull();
    expect(screen.getByText('Questions you asked')).toBeTruthy();
  });

  it('treats a visitor who hosted a session like a visitor: no controls, no questions', async () => {
    // A visitor's own session (a replay of their own) still carries their id.
    mount(ANONYMOUS, ANONYMOUS.id, features('free', true));
    await waitFor(() => expect(screen.getByTestId('session-expert')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('comment-signin')).toBeTruthy());
    expect(screen.queryByTestId('owner-controls')).toBeNull();
    expect(screen.queryByText('Questions you asked')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
