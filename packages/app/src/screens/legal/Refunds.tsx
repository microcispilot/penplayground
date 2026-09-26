import { LegalLayout, LegalLink, LI, Mail, P, Strong, UL } from './LegalLayout.js';

/** The refund window, in hours, as the owner set it (2026-09-25, ADR-0057). Terms and Pricing quote this. */
export const REFUND_WINDOW_HOURS = 48;

/**
 * Cancellation and Refund Policy (ADR-0057). The owner's rule is one line:
 * cancel within 48 hours of a charge for a full refund; after that, no
 * refund, and the plan runs to the end of the period already paid for.
 * Written the way the platforms people already know write theirs: what you
 * can do, when, how, and what the law adds on top.
 */
export function Refunds() {
  return (
    <LegalLayout
      title="Cancellation and Refund Policy"
      intro="How to cancel a Pen Playground subscription, when a payment is refunded, and what happens to your access."
      sections={[
        {
          id: 'overview',
          title: 'Overview',
          body: (
            <>
              <P>
                This policy applies to the paid Pen Playground plans, Standard and Professional,
                sold by <Strong>Microcis</Strong>, a California limited liability company. It forms
                part of our <LegalLink to="/terms">Terms of Use</LegalLink>.
              </P>
              <P>
                In short: you can cancel at any time, and a payment is refunded in full when you
                cancel within {REFUND_WINDOW_HOURS} hours of being charged. After that window a
                payment is not refunded, and your plan stays active until the end of the period you
                have paid for.
              </P>
            </>
          ),
        },
        {
          id: 'cancelling',
          title: 'Cancelling your subscription',
          body: (
            <>
              <P>
                You can cancel at any time from the billing portal, which you reach from the pricing
                page or your account page while signed in. Cancelling stops the next renewal. It
                does not end your access early: everything your plan includes stays available until
                the last day of the period you have already paid for, and your account then returns
                to the free plan.
              </P>
              <P>
                Cancelling does not delete your account, your sessions or your recordings. Those
                remain yours under the <LegalLink to="/privacy">Privacy Policy</LegalLink>.
              </P>
            </>
          ),
        },
        {
          id: 'refund-window',
          title: `The ${REFUND_WINDOW_HOURS}-hour refund window`,
          body: (
            <>
              <P>
                Every charge, whether it is your first payment or a renewal, comes with a{' '}
                {REFUND_WINDOW_HOURS}-hour window. If you cancel within {REFUND_WINDOW_HOURS} hours
                of the charge, that charge is refunded in full to the payment method you used.
              </P>
              <UL>
                <LI>
                  The window starts at the moment the charge is made, not when you first use the
                  plan.
                </LI>
                <LI>
                  A refunded charge ends the paid period it covered. Your account returns to the
                  free plan when the refund is issued.
                </LI>
                <LI>
                  Refunds are processed through our payment provider, Stripe, and usually appear on
                  your statement within five to ten business days, depending on your bank.
                </LI>
              </UL>
            </>
          ),
        },
        {
          id: 'after-the-window',
          title: `After ${REFUND_WINDOW_HOURS} hours`,
          body: (
            <>
              <P>
                A charge that is more than {REFUND_WINDOW_HOURS} hours old is not refunded, in whole
                or in part. This includes the unused remainder of a monthly or yearly period, time
                during which you did not use the service, and a plan you forgot to cancel before it
                renewed. To avoid an unwanted renewal, cancel before your renewal date; the date is
                shown in the billing portal.
              </P>
              <P>
                Moving between Standard and Professional does not open a new refund window for the
                period already paid for.
              </P>
            </>
          ),
        },
        {
          id: 'yearly-plans',
          title: 'Yearly plans',
          body: (
            <P>
              A yearly plan is charged once for twelve months and follows the same rule: a full
              refund if you cancel within {REFUND_WINDOW_HOURS} hours of the charge, and no refund
              for unused months after that. The plan stays active until the end of the year you paid
              for.
            </P>
          ),
        },
        {
          id: 'free-plan',
          title: 'The free plan',
          body: (
            <P>
              The free plan costs nothing, so there is nothing to refund. You can stop using it or
              delete your account at any time from your account page.
            </P>
          ),
        },
        {
          id: 'billing-errors-and-legal-rights',
          title: 'Billing errors and your legal rights',
          body: (
            <>
              <P>
                A duplicate charge, a charge after you cancelled, or any other billing error is
                corrected and refunded in full regardless of when it happened. Write to us with the
                email address on your account and the date of the charge.
              </P>
              <P>
                Where the law of the country or state you live in gives you a longer or broader
                right to cancel or to a refund, that right applies and nothing in this policy limits
                it.
              </P>
            </>
          ),
        },
        {
          id: 'how-to-request-a-refund',
          title: 'How to request a refund',
          body: (
            <>
              <P>
                Cancel your subscription in the billing portal, then email <Mail /> from the address
                on your account with the date of the charge. We confirm the cancellation and the
                refund by email, and the refund is issued to your original payment method.
              </P>
              <P>
                Disputing a charge with your bank instead of writing to us first can delay the
                refund. We are happy to help directly.
              </P>
            </>
          ),
        },
        {
          id: 'changes-and-contact',
          title: 'Changes and contact',
          body: (
            <P>
              We may update this policy from time to time. The date at the top of the page is the
              date of the current version, and a change never shortens a refund window that has
              already started. Questions about this page: <Mail />.
            </P>
          ),
        },
      ]}
    />
  );
}
