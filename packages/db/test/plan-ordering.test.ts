import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Connection, connect, ParticipantRepository } from '../src/index.js';

/**
 * A plan change that arrives late must not undo the one that superseded it.
 *
 * Stripe's webhooks are at-least-once and in no particular order. A failed
 * delivery is retried for days, so a `customer.subscription.updated` can land
 * minutes — or a day — after the `customer.subscription.deleted` that made it
 * obsolete. `setPlan` was an unconditional UPDATE, so that retry **restored a
 * cancelled subscriber's entitlements**, and nothing would ever have
 * corrected it: the row afterwards looks exactly like an ordinary paying
 * customer, and no later event is coming.
 *
 * `planSince` is Stripe's `event.created`, and it is now the guard as well as
 * the record.
 */
let conn: Connection;
let participants: ParticipantRepository;

const AT = (iso: string) => new Date(iso);
const CANCELLED = AT('2026-09-19T12:00:05.000Z');
const EARLIER = AT('2026-09-19T12:00:00.000Z');

beforeEach(async () => {
  conn = await connect('pglite://memory');
  participants = new ParticipantRepository(conn.db);
  await participants.ensure({ id: 'p_1', name: 'Ada', plan: 'free', anonymous: false });
});
afterEach(async () => {
  await conn.close();
});

describe('setPlan, when the webhooks arrive out of order', () => {
  it('refuses a change older than the one on the row, and says so', async () => {
    expect(
      await participants.setPlan('p_1', 'free', 'cus_1', {
        interval: 'month',
        status: 'canceled',
        since: CANCELLED,
      }),
    ).toBe(true);

    // The retried `subscription.updated` for the subscription that was
    // cancelled five seconds later.
    expect(
      await participants.setPlan('p_1', 'standard', 'cus_1', {
        interval: 'month',
        status: 'active',
        since: EARLIER,
      }),
      'an older event is refused',
    ).toBe(false);

    const row = await participants.get('p_1');
    expect(row?.plan, 'the cancellation stands').toBe('free');
    expect(row?.planStatus).toBe('canceled');
    expect(row?.planSince?.getTime()).toBe(CANCELLED.getTime());
  });

  it('applies a change newer than the one on the row', async () => {
    await participants.setPlan('p_1', 'free', 'cus_1', { status: 'canceled', since: EARLIER });
    expect(
      await participants.setPlan('p_1', 'professional', 'cus_1', {
        interval: 'year',
        status: 'active',
        since: CANCELLED,
      }),
    ).toBe(true);
    const row = await participants.get('p_1');
    expect(row?.plan).toBe('professional');
    expect(row?.planInterval).toBe('year');
  });

  /**
   * Stripe's `created` is in whole seconds, so two events inside one second
   * are simultaneous as far as anything here can tell. A tie is decided by
   * which mistake is recoverable, and the two halves of that rule are here.
   */
  it('keeps the cancellation when an upgrade claims the same moment', async () => {
    await participants.setPlan('p_1', 'free', 'cus_1', { status: 'canceled', since: CANCELLED });
    expect(
      await participants.setPlan('p_1', 'standard', 'cus_1', {
        status: 'active',
        since: CANCELLED,
      }),
    ).toBe(false);
    expect((await participants.get('p_1'))?.plan).toBe('free');
  });

  /**
   * And the other way, which is the one that matters more: refusing a
   * cancellation would leave a cancelled subscriber entitled for ever,
   * because no further event is coming. Refusing an upgrade costs minutes.
   */
  it('lets a cancellation win a tie', async () => {
    await participants.setPlan('p_1', 'standard', 'cus_1', {
      status: 'active',
      since: CANCELLED,
    });
    expect(
      await participants.setPlan('p_1', 'free', 'cus_1', {
        status: 'canceled',
        since: CANCELLED,
      }),
      'the cancellation is applied',
    ).toBe(true);
    expect((await participants.get('p_1'))?.plan).toBe('free');
  });

  it('still refuses a cancellation that is genuinely older', async () => {
    await participants.setPlan('p_1', 'standard', 'cus_1', {
      status: 'active',
      since: CANCELLED,
    });
    expect(
      await participants.setPlan('p_1', 'free', 'cus_1', { status: 'canceled', since: EARLIER }),
    ).toBe(false);
    expect((await participants.get('p_1'))?.plan).toBe('standard');
  });

  it('applies the first change a row ever gets, whatever its timestamp', async () => {
    expect(await participants.setPlan('p_1', 'standard', 'cus_1', { since: EARLIER })).toBe(true);
    expect((await participants.get('p_1'))?.plan).toBe('standard');
  });

  /** The places that are not a webhook — a manual grant, a test — order nothing. */
  it('is unconditional when no moment is given', async () => {
    await participants.setPlan('p_1', 'professional', 'cus_1', { since: CANCELLED });
    expect(await participants.setPlan('p_1', 'free')).toBe(true);
    expect((await participants.get('p_1'))?.plan).toBe('free');
    // And it left the record of when the plan last moved alone.
    expect((await participants.get('p_1'))?.planSince?.getTime()).toBe(CANCELLED.getTime());
  });

  it('is false rather than an error for a participant that is not there', async () => {
    expect(await participants.setPlan('p_nobody', 'standard', 'cus_x', { since: CANCELLED })).toBe(
      false,
    );
  });
});
