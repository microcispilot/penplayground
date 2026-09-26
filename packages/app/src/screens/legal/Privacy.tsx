import { Contact, LegalLayout, LegalLink, LI, P, Strong, UL } from './LegalLayout.js';

/**
 * Privacy Policy. Simurgh's structure and entity, with the substance rewritten
 * for what Pen Playground actually processes: an anonymous participant id or a
 * Google profile, the topic and questions you ask, the recorded lesson audio
 * and board (public by default, never with your name), microphone audio for
 * speech recognition, content-free analytics and error reports, Stripe
 * payments, and Google Ad Manager on the free plan.
 */
export function Privacy() {
  return (
    <LegalLayout
      title="Privacy Policy"
      intro="What Pen Playground processes when you learn here, why, who else sees it, and the choices you have."
      sections={[
        {
          id: 'who-we-are',
          title: 'Who we are',
          body: (
            <P>
              <Strong>Microcis</Strong>, a California limited liability company, provides Pen
              Playground: a place where an AI expert teaches you live over voice and a shared
              whiteboard. This policy describes the personal information the Service processes and
              the choices you have. Questions, or a request about your data, go through <Contact />.
            </P>
          ),
        },
        {
          id: 'what-we-process',
          title: 'What we process',
          body: (
            <>
              <P>
                <Strong>Your account.</Strong> You can learn without signing in: we issue an
                anonymous participant id and store it on your device, and your sessions belong to
                it. If you sign in with Google we receive and store your name, email address and
                profile picture, and Google&rsquo;s stable account identifier, attached to that same
                participant — which is why what you started anonymously comes with you. You can set
                a display name of your own; it is shown to the expert and to anyone you invite to a
                room.
              </P>
              <P>
                <Strong>Sessions.</Strong> For each session we process and keep the topic you typed
                or spoke, the questions you asked, the lesson the expert taught, the board it wrote,
                the transcript and the recorded audio, together with timings and how far you got.
                <Strong> New sessions are public by default</Strong>: the recording can appear in
                the catalog and be replayed by anyone with the link.{' '}
                <Strong>Your name is never shown on one</Strong> — the creator is stripped from the
                public record, and names in the transcript are replaced for everyone but you. You
                can create a session as private instead, and you can ask us to remove one.
              </P>
              <P>
                <Strong>Microphone audio.</Strong> Audio is captured only while your microphone is
                on, and the microphone&rsquo;s state is always visible. Depending on your browser
                and our configuration, speech recognition happens on your device, or the audio is
                sent through our relay to a speech-to-text provider and the text comes back. Audio
                captured as part of a session becomes part of that session&rsquo;s recording; audio
                used only to recognise what you said is not kept as a separate record once the text
                exists.
              </P>
              <P>
                <Strong>Payments.</Strong> Stripe processes payment details; we never see or store
                your full card number. We receive and keep your subscription status, plan, billing
                interval and a customer reference so we can give you what you paid for.
              </P>
              <P>
                <Strong>Ads on the free plan.</Strong> Video ads are served by Google Ad Manager.
                Google sets its own cookies and identifiers in your browser and uses them to select
                and measure ads, under Google&rsquo;s privacy policy. We receive counts — whether an
                ad loaded, started, was skipped or completed — never who you are to Google. Paid
                plans see no ads and no ad identifiers.
              </P>
              <P>
                <Strong>Analytics and error reports.</Strong> We use PostHog for product analytics
                and Sentry for error monitoring. Both are configured to be{' '}
                <Strong>content-free</Strong>: they receive event names, codes, counts, timings, the
                screen you were on and identifiers, and they do not receive your topic, your
                questions, transcripts, or anything the expert said. There is no session recording
                and no autocapture.
              </P>
              <P>
                <Strong>Operations.</Strong> To run and secure the Service we also process the usual
                technical records: IP address, browser or app version, operating system, and
                security and diagnostic signals.
              </P>
            </>
          ),
        },
        {
          id: 'why-we-process-it',
          title: 'Why we process it',
          body: (
            <UL>
              <LI>to teach the lesson you asked for, and to answer your questions in it;</LI>
              <LI>
                to keep your sessions so you — and, for public ones, others — can replay them;
              </LI>
              <LI>to recognise your speech so the expert can hear you;</LI>
              <LI>to identify you across devices when you choose to sign in;</LI>
              <LI>to take payment, apply your plan, and prevent fraud and abuse;</LI>
              <LI>to show and measure ads on the free plan;</LI>
              <LI>
                to see what works, find failures and make the Service faster and more reliable; and
              </LI>
              <LI>to meet legal obligations and to protect users and the Service.</LI>
            </UL>
          ),
        },
        {
          id: 'who-else-sees-it',
          title: 'Who else sees it',
          body: (
            <>
              <P>
                <Strong>We do not sell personal information</Strong>, and we do not share it for
                cross-context behavioural advertising beyond the advertising described above, which
                you can avoid entirely by using a paid plan.
              </P>
              <P>
                We disclose information to the providers that make the Service work —
                language-model, speech-recognition and voice providers, cloud hosting and media
                delivery, Google for sign-in, Stripe for payments, Google Ad Manager for ads,
                PostHog and Sentry as described — each only with what it needs for its part. We also
                disclose information when the law requires it, to protect users or the Service, or
                as part of a business transaction with equivalent protections in place.
              </P>
              <P>
                Anyone can see a public session: its recording, its board and its transcript. Nobody
                sees your name on it.
              </P>
            </>
          ),
        },
        {
          id: 'retention',
          title: 'How long we keep it',
          body: (
            <P>
              Account and billing records are kept while you have an account and for as long
              afterwards as the law requires. Sessions and their recordings are kept until you or we
              delete them — deleting a session removes its recording, its transcript and its
              thumbnail. Security and diagnostic records are kept for a short, bounded period.
              Content-free analytics and error events are kept under each provider&rsquo;s retention
              settings. Data stored on your device — your participant id, your display name, your
              theme and sidebar preferences, and the pace you last chose — stays there until you
              clear it or sign out. If you are signed in, the pace is also kept on your account so
              your next session starts at it on any device.
            </P>
          ),
        },
        {
          id: 'your-choices',
          title: 'Your choices and rights',
          body: (
            <>
              <P>
                You choose whether your microphone is on, whether to sign in, and whether a session
                is public or private. You can rename yourself, sign out — which returns you to a
                fresh anonymous participant — and ask us to delete your account, your sessions, or a
                single session, through <Contact />.
              </P>
              <P>
                Depending on where you live you may have rights to access, correct, export, delete
                or restrict the processing of your personal information, to object to it, and to
                complain to your data protection authority. California residents have the rights
                described in the CCPA/CPRA, including the right not to be discriminated against for
                using them. Send the request through <Contact /> and we will verify it and act on it
                within the time the law allows.
              </P>
            </>
          ),
        },
        {
          id: 'security-and-transfers',
          title: 'Security, international processing, and children',
          body: (
            <>
              <P>
                We protect information with encrypted transport, access controls, short-lived
                credentials and abuse protection. No system is perfectly secure; treat a public
                session as public and do not say or show anything in one that you would not want
                replayed.
              </P>
              <P>
                Microcis is based in the United States, and our providers may process data in the
                United States and other countries. Where transfers out of the European Economic Area
                or the United Kingdom require safeguards, we rely on the appropriate ones, including
                the Standard Contractual Clauses.
              </P>
              <P>
                The Service is for people aged 13 and over, and 16 and over in the European Economic
                Area and the United Kingdom. We do not knowingly collect personal information from
                children below those ages; if you believe a child has given us information, tell us
                through <Contact /> and we will delete it.
              </P>
            </>
          ),
        },
        {
          id: 'changes',
          title: 'Changes and contact',
          body: (
            <>
              <P>
                We update this policy as the product changes. If a change materially affects you we
                will say so in the product or by email before it takes effect, and the date at the
                top of this page will change.
              </P>
              <P>
                Questions, or a request about your data: <Contact>contact us</Contact>. The{' '}
                <LegalLink to="/terms">Terms of Use</LegalLink> cover the agreement itself.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
