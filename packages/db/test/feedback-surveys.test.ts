import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Connection,
  connect,
  FeedbackRepository,
  ParticipantRepository,
  SurveyRepository,
} from '../src/index.js';

/**
 * Feedback and surveys (ADR-0060), at the table: the inbox lists newest
 * first with honest counts, the daily allowance is counted from rows, a
 * deleted account leaves the words and takes the person; a survey is
 * answered once per showing, skips count, and "other" is the only free text.
 */
let conn: Connection;
let feedback: FeedbackRepository;
let surveys: SurveyRepository;
let participants: ParticipantRepository;

beforeAll(async () => {
  conn = await connect('pglite://memory');
  feedback = new FeedbackRepository(conn.db);
  surveys = new SurveyRepository(conn.db);
  participants = new ParticipantRepository(conn.db);
  await participants.ensure({ id: 'p_ada', name: 'Ada', plan: 'standard', anonymous: false });
  await participants.ensure({ id: 'p_vis', name: 'Learner', plan: 'free', anonymous: true });
});
afterAll(async () => {
  await conn.close();
});

const at = (offset: number) => 1_760_000_000_000 + offset;

describe('feedback', () => {
  it('stores a submission with its author read at listing time, newest first, with counts', async () => {
    const a = await feedback.create({
      id: 'f_1',
      kind: 'issue',
      message: 'The board stopped drawing after the second segment.',
      email: null,
      name: null,
      participantId: 'p_ada',
      screen: 'room',
      platform: 'web',
      release: 'abc1234',
      environment: 'staging',
      now: at(1_000),
    });
    expect(a).toMatchObject({
      id: 'f_1',
      status: 'new',
      participantName: 'Ada',
      participantPlan: 'standard',
      participantAnonymous: false,
    });
    await feedback.create({
      id: 'f_2',
      kind: 'contact',
      message: 'Do you offer plans for a school of forty students?',
      email: 'head@school.example',
      name: 'Sam',
      participantId: 'p_vis',
      screen: 'feedback',
      platform: 'web',
      release: 'abc1234',
      environment: 'staging',
      now: at(2_000),
    });
    const page = await feedback.list();
    expect(page.rows.map((r) => r.id)).toEqual(['f_2', 'f_1']);
    expect(page.total).toBe(2);
    expect(page.counts).toEqual({ new: 2, seen: 0, resolved: 0 });
    const issues = await feedback.list({ kind: 'issue' });
    expect(issues.rows.map((r) => r.id)).toEqual(['f_1']);
    expect(issues.total).toBe(1);
    // The counts are the inbox's, not the filter's.
    expect(issues.counts.new).toBe(2);
  });

  it('moves status and keeps a note, and counts a participant’s day', async () => {
    const seen = await feedback.update('f_1', { status: 'seen' }, at(3_000));
    expect(seen?.status).toBe('seen');
    expect(seen?.updatedAt).toBe(at(3_000));
    const resolved = await feedback.update('f_1', {
      status: 'resolved',
      adminNote: 'Fixed in 4de1a77',
    });
    expect(resolved).toMatchObject({ status: 'resolved', adminNote: 'Fixed in 4de1a77' });
    expect((await feedback.list()).counts).toEqual({ new: 1, seen: 0, resolved: 1 });
    expect(await feedback.countSince('p_ada', at(0))).toBe(1);
    expect(await feedback.countSince('p_ada', at(1_500))).toBe(0);
  });

  it('a deleted account leaves the words and takes the person', async () => {
    await feedback.anonymise('p_vis');
    const row = await feedback.get('f_2');
    expect(row).toMatchObject({
      participantId: null,
      participantName: null,
      email: null,
      name: null,
      message: 'Do you offer plans for a school of forty students?',
    });
  });
});

describe('surveys', () => {
  it('records answers and skips, remembers the latest, and summarises by option', async () => {
    await surveys.record({
      id: 's_1',
      participantId: 'p_ada',
      kind: 'signup_source',
      option: 'youtube',
      other: null,
      trigger: 'checkout',
      plan: 'standard',
      planInterval: 'month',
      now: at(1_000),
    });
    await surveys.record({
      id: 's_2',
      participantId: 'p_vis',
      kind: 'signup_source',
      option: 'skipped',
      other: null,
      trigger: 'checkout',
      plan: 'free',
      planInterval: null,
      now: at(2_000),
    });
    await surveys.record({
      id: 's_3',
      participantId: 'p_ada',
      kind: 'cancel_reason',
      option: 'other',
      other: 'Moving countries for a year',
      trigger: 'subscription_cancelled',
      plan: 'standard',
      planInterval: 'month',
      now: at(3_000),
    });
    // Free text is kept only behind "other".
    const stray = await surveys.record({
      id: 's_4',
      participantId: 'p_vis',
      kind: 'cancel_reason',
      option: 'not_using',
      other: 'this should not be kept',
      trigger: 'account_deleted',
      plan: 'free',
      planInterval: null,
      now: at(4_000),
    });
    expect(stray.other).toBeNull();

    expect((await surveys.latest('p_ada', 'signup_source'))?.option).toBe('youtube');
    expect(await surveys.latest('p_vis', 'cancel_reason')).toMatchObject({ option: 'not_using' });
    expect(await surveys.latest('p_ada', 'signup_source')).not.toBeNull();

    const [signup, cancel] = await surveys.summary({ from: at(0), to: at(10_000) });
    expect(signup).toMatchObject({ kind: 'signup_source', answered: 1, skipped: 1 });
    expect(signup?.options.find((o) => o.id === 'youtube')?.count).toBe(1);
    expect(cancel).toMatchObject({ kind: 'cancel_reason', answered: 2, skipped: 0 });
    expect(cancel?.others).toEqual([
      { text: 'Moving countries for a year', at: at(3_000), trigger: 'subscription_cancelled' },
    ]);
  });

  it('a deleted account keeps its answers as statistics, unattributed', async () => {
    await surveys.anonymise('p_ada');
    expect(await surveys.forParticipant('p_ada')).toEqual([]);
    const [signup] = await surveys.summary({ from: at(0), to: at(10_000) });
    expect(signup?.options.find((o) => o.id === 'youtube')?.count).toBe(1);
  });
});
