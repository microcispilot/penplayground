import { Contact, LegalLayout, LegalLink, LI, P, Strong, UL } from './LegalLayout.js';

/**
 * Terms of Use. Ported from Simurgh's structure and entity (Microcis, a
 * California LLC) with every product-specific clause rewritten for what Pen
 * Playground actually does: an AI expert teaching over voice and a shared
 * whiteboard, sessions that are recorded and public by default, ads on the
 * free plan, and two paid tiers.
 */
export function Terms() {
  return (
    <LegalLayout
      title="Terms of Use"
      intro="The agreement between you and Microcis for Pen Playground — what the service is, what you can expect from it, and what we ask of you."
      sections={[
        {
          id: 'what-pen-playground-is',
          title: 'What Pen Playground is',
          body: (
            <>
              <P>
                These Terms of Use form an agreement between you and <Strong>Microcis</Strong>, a
                California limited liability company (&ldquo;Microcis,&rdquo; &ldquo;Pen
                Playground,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;), for
                the Pen Playground website and applications (together, the &ldquo;Service&rdquo;).
              </P>
              <P>
                You say what you want to learn, and an expert teaches it to you live: talking,
                writing on a shared whiteboard, answering your questions, and picking the lesson
                back up where it stopped. <Strong>Every expert is an AI.</Strong> Each one carries
                that disclosure and will say so if you ask. An expert is a persona — a name, a
                manner, a voice — never a claim about a real person, and never a licensed
                professional.
              </P>
              <P>
                On the Professional plan a session can be a room: you host, and the people you
                invite listen, watch the same board and ask their own questions. A seat in a room is
                part of the Standard and Professional plans, so each guest joins on a plan of their
                own.
              </P>
            </>
          ),
        },
        {
          id: 'ai-limitations',
          title: 'AI limitations and no professional advice',
          body: (
            <>
              <P>
                Lessons and answers are generated. They can be inaccurate, incomplete, or out of
                date, even when the expert cites the evidence it was given. You are responsible for
                checking anything you intend to rely on.
              </P>
              <P>
                The Service is not medical, legal, financial, tax, safety-critical, or other
                regulated professional advice, and using it creates no professional, fiduciary, or
                employment relationship. Use a qualified professional for consequential decisions,
                and local emergency services for emergencies.
              </P>
            </>
          ),
        },
        {
          id: 'who-can-use-it',
          title: 'Who can use it, and accounts',
          body: (
            <>
              <P>
                You must be at least 13 years old to use the Service, and at least 16 if you are in
                the European Economic Area or the United Kingdom. If you are below the age of
                majority where you live, you may use the Service only with a parent or guardian who
                agrees to these Terms.
              </P>
              <P>
                You can start learning without an account: we issue an anonymous participant id to
                the device you are using, and your sessions belong to it. Signing in with Google
                attaches a name, email address and profile picture to that same participant, so what
                you already started comes with you and follows you to your other devices. Keep your
                Google account secure, and tell us through <Contact /> if you believe someone else
                has reached your Pen Playground account.
              </P>
            </>
          ),
        },
        {
          id: 'sessions-are-public',
          title: 'Sessions are recorded, and public by default',
          body: (
            <>
              <P>
                A session is recorded as it is taught: the lesson audio, the board, the transcript
                and the questions asked in it. <Strong>New sessions are public by default</Strong> —
                they can appear in the catalog, be opened by a link, and be replayed by anyone. Your
                name is never shown on a public session, and neither is anyone else&rsquo;s.
              </P>
              <P>
                You can create a session as private instead, and you can ask us to remove one of
                yours through <Contact />. What you say out loud or type during a session becomes
                part of that recording, so treat a session the way you would treat a room with the
                door open: do not share secrets, credentials, someone else&rsquo;s personal
                information, or material you do not have the right to share.
              </P>
              <P>
                The <LegalLink to="/privacy">Privacy Policy</LegalLink> describes what is processed
                and kept.
              </P>
            </>
          ),
        },
        {
          id: 'plans-and-billing',
          title: 'Plans, ads, and billing',
          body: (
            <>
              <P>
                The free plan is real: solo sessions with any expert, replay of your own sessions,
                and a daily limit on how many sessions you can start. It is supported by a short,
                skippable video ad shown over the board between segments — never inside the lesson,
                never spoken by the expert, and never on a paid plan.
              </P>
              <P>
                Standard removes the ads and adds unlimited sessions, video export and premium
                voices. Professional adds rooms with up to twelve participants. Current prices and
                what each plan includes are on the pricing page.
              </P>
              <P>
                Paid plans are billed in advance through Stripe and renew automatically until you
                cancel. Cancelling stops the next renewal and leaves your paid access in place until
                the end of the period you have already paid for. A charge is refunded in full when
                you cancel within 48 hours of it, and is not refunded after that; the{' '}
                <LegalLink to="/refunds">Cancellation and Refund Policy</LegalLink> has the detail.
                You can manage or cancel your subscription from the billing portal at any time.
                Where the law gives you a withdrawal or refund right, that right applies regardless
                of anything here.
              </P>
            </>
          ),
        },
        {
          id: 'acceptable-use',
          title: 'Acceptable use',
          body: (
            <>
              <P>You may not:</P>
              <UL>
                <LI>use the Service unlawfully, or to harm, deceive, harass or infringe others;</LI>
                <LI>
                  ask an expert to produce material that exploits children, facilitates violence,
                  fraud or malware, or is designed to deceive people about who made it;
                </LI>
                <LI>
                  attempt to reach accounts, sessions, data or systems you have not been given
                  access to;
                </LI>
                <LI>bypass security, usage, billing, or ad controls, or misreport your plan;</LI>
                <LI>
                  disrupt, overload, scrape or automate the Service except as we expressly allow;
                </LI>
                <LI>
                  present an expert as a real person, or a generated lesson as reviewed professional
                  advice; or
                </LI>
                <LI>remove notices, or misuse the Pen Playground name, personas or assets.</LI>
              </UL>
              <P>
                We may suspend or end access where it is reasonably necessary to deal with a
                violation, a security risk, a legal requirement, or material harm to the Service or
                its users.
              </P>
            </>
          ),
        },
        {
          id: 'your-content-and-ours',
          title: 'Your content, generated lessons, and our software',
          body: (
            <>
              <P>
                You keep whatever rights you already hold in what you provide — the topic you ask
                for, your questions, and anything you say or type in a session. You grant Microcis
                the rights needed to host, transmit, record and process that material to provide,
                secure and support the Service, and — for a session that is public — to show that
                recording to others without your name.
              </P>
              <P>
                Subject to these Terms and to law, you may use what an expert produces for you. AI
                output is not unique: similar lessons may be generated for other learners on the
                same topic, and nothing here gives you exclusive rights in them.
              </P>
              <P>
                The Service, its software, the expert personas, portraits, voices, the board and the
                brand belong to Microcis or its licensors. You get a personal, non-exclusive,
                non-transferable licence to use the Service as it is offered.
              </P>
            </>
          ),
        },
        {
          id: 'third-parties',
          title: 'Third-party services',
          body: (
            <P>
              The Service depends on others: Google for sign-in, Stripe for payments, Google Ad
              Manager for the ads on the free plan, and providers for language models, speech
              recognition, voice synthesis, media delivery, product analytics and error monitoring.
              Their terms apply to their own services. The{' '}
              <LegalLink to="/privacy">Privacy Policy</LegalLink> names the categories and what each
              one receives.
            </P>
          ),
        },
        {
          id: 'disclaimers',
          title: 'Disclaimers and liability',
          body: (
            <>
              <P>
                The Service is provided as it is. To the fullest extent the law allows, Microcis
                disclaims implied warranties of merchantability, fitness for a particular purpose
                and non-infringement, and does not warrant that lessons will be accurate or that the
                Service will be uninterrupted or error-free.
              </P>
              <P>
                To the fullest extent the law allows, Microcis is not liable for indirect,
                incidental, special, consequential or punitive damages, or for lost profits or data;
                and our total liability for any claim relating to the Service is limited to the
                greater of the amount you paid us in the twelve months before the claim, or US$100.
                Nothing here limits a right or remedy that cannot lawfully be limited, including
                liability for fraud, gross negligence, or death or personal injury caused by
                negligence.
              </P>
              <P>
                These Terms are governed by the laws of the State of California, without regard to
                its conflict-of-laws rules, and the state and federal courts in California have
                jurisdiction — except where the law of your home country gives you the right to
                bring proceedings there, which it may.
              </P>
            </>
          ),
        },
        {
          id: 'changes-and-contact',
          title: 'Changes, ending, and contact',
          body: (
            <>
              <P>
                We may update these Terms as the product changes. If a change materially affects
                you, we will say so in the product or by email before it takes effect, and the date
                at the top of this page will change. Continuing to use the Service after that means
                you accept the updated Terms.
              </P>
              <P>
                You can stop using the Service at any time, and you can ask us to delete your
                account and your sessions through <Contact />. Sections that are meant to survive —
                your grant for sessions already public, disclaimers, liability limits and governing
                law — continue to apply afterwards.
              </P>
              <P>
                Questions about these Terms: <Contact>contact us</Contact>.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
