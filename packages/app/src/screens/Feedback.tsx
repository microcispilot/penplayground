import {
  FEEDBACK_KIND_LABEL,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  FeedbackKind,
} from '@pen/contracts';
import { Button, cn, TextField } from '@pen/design';
import { Check, Lightbulb, Mail, MessageSquareText, Sparkles, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.js';
import { ShellPage } from '../components/AppShell.js';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useSeo } from '../lib/seo.js';

/**
 * Feedback and support (ADR-0060): one page for an issue, an improvement, a
 * feature and a message to us. The kind is a choice, the message is the
 * page, and a reply address is asked for only when there is none on the
 * account or the message is a contact. What is written here goes to the
 * inbox and the console, never to a log or an analytics event.
 */
const KINDS: { kind: FeedbackKind; icon: ReactNode; hint: string }[] = [
  {
    kind: 'issue',
    icon: <TriangleAlert size={18} />,
    hint: 'Something did not work as it should.',
  },
  { kind: 'suggestion', icon: <Lightbulb size={18} />, hint: 'Something could be better.' },
  { kind: 'feature', icon: <Sparkles size={18} />, hint: 'Something you wish it could do.' },
  { kind: 'contact', icon: <Mail size={18} />, hint: 'Anything else, and we will write back.' },
];

const PLACEHOLDER: Record<FeedbackKind, string> = {
  issue: 'What happened, what you expected, and where you were in the app.',
  suggestion: 'What could work better, and how you would like it to work.',
  feature: 'What you would like to do that you cannot do today.',
  contact: 'How can we help?',
};

function kindFrom(value: string | null): FeedbackKind {
  const parsed = FeedbackKind.safeParse(value);
  return parsed.success ? parsed.data : 'issue';
}

export function Feedback() {
  useSeo({
    title: 'Feedback and support',
    description: 'Report an issue, suggest an improvement, ask for a feature, or contact us.',
  });
  const { api, participant } = useApp();
  const [params] = useSearchParams();
  const [kind, setKind] = useState<FeedbackKind>(() => kindFrom(params.get('kind')));
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<FeedbackKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trackAction('feedback_opened', { kind: kindFrom(params.get('kind')) });
  }, [params]);

  const accountEmail = participant && !participant.anonymous ? participant.email : null;
  const needsEmail = !accountEmail || kind === 'contact';
  const replyTo = (email.trim() || accountEmail || '').trim();
  const tooShort = message.trim().length < FEEDBACK_MESSAGE_MIN;
  const tooLong = message.length > FEEDBACK_MESSAGE_MAX;
  const canSend =
    !busy && !tooShort && !tooLong && (!needsEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo));

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendFeedback({
        kind,
        message: message.trim(),
        ...(replyTo ? { email: replyTo } : {}),
        screen: 'feedback',
      });
      trackAction('feedback_sent', { kind, length: message.trim().length });
      setSent(kind);
      setMessage('');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'NETWORK';
      trackAction('feedback_failed', { kind, code });
      setError(
        e instanceof ApiError && e.status === 429
          ? e.message
          : e instanceof ApiError && e.code === 'EMAIL_REQUIRED'
            ? 'Add an email address so we can reply to you.'
            : 'It could not be sent just now. Your message is still here, so please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ShellPage
      title="Feedback and support"
      intro="Tell us what went wrong, what could be better, or what you would like next."
    >
      <div className="max-w-[720px]">
        {sent ? (
          <section
            className="hairline flex flex-col gap-3 rounded-lg bg-surface-container-low p-6"
            data-testid="feedback-sent"
          >
            <div className="flex items-center gap-2 text-title-medium">
              <Check size={20} className="text-success" aria-hidden />
              {sent === 'contact' ? 'Your message is on its way.' : 'Thank you. We have it.'}
            </div>
            <p className="text-body-medium text-on-surface-variant text-pretty">
              {sent === 'contact'
                ? `We reply to ${replyTo || 'the address on your account'} as soon as we can.`
                : 'We read every submission and it shapes what we build next.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setSent(null)}>
                Send another
              </Button>
              <Link to="/" className="inline-flex">
                <Button variant="ghost">Back to Explore</Button>
              </Link>
            </div>
          </section>
        ) : (
          <form
            className="flex flex-col gap-7"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <legend className="mb-3 text-title-medium">What would you like to tell us?</legend>
              {KINDS.map((k) => {
                const chosen = kind === k.kind;
                return (
                  <label
                    key={k.kind}
                    className={cn(
                      'state-layer flex cursor-pointer items-start gap-3 rounded-lg px-4 py-3.5 text-left transition-colors',
                      chosen
                        ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_var(--color-primary)]'
                        : 'hairline text-on-surface-variant',
                    )}
                  >
                    <input
                      type="radio"
                      name="feedback-kind"
                      value={k.kind}
                      checked={chosen}
                      onChange={() => setKind(k.kind)}
                      className="sr-only"
                      data-testid={`feedback-kind-${k.kind}`}
                    />
                    <span className="mt-0.5 shrink-0">{k.icon}</span>
                    <span className="flex flex-col">
                      <span className="text-label-large font-semibold">
                        {FEEDBACK_KIND_LABEL[k.kind]}
                      </span>
                      <span className="text-body-small">{k.hint}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <label className="flex flex-col gap-2">
              <span className="text-title-medium">Your message</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={PLACEHOLDER[kind]}
                rows={7}
                maxLength={FEEDBACK_MESSAGE_MAX + 200}
                dir="auto"
                data-testid="feedback-message"
                className={cn(
                  'w-full resize-y rounded-md bg-surface-container-low px-4 py-3 text-body-large text-on-surface caret-primary outline-none placeholder:text-on-surface-dim',
                  'shadow-[0_0_0_1px_var(--color-outline-variant)] focus:shadow-[0_0_0_2px_var(--color-outline)]',
                  tooLong && 'shadow-[0_0_0_2px_var(--color-error)]',
                )}
              />
              <span
                className={cn('text-body-small', tooLong ? 'text-error' : 'text-on-surface-dim')}
              >
                {tooLong
                  ? `A message can be ${FEEDBACK_MESSAGE_MAX.toLocaleString()} characters; this one is ${message.length.toLocaleString()}.`
                  : message.length > 0 && tooShort
                    ? `A few more words, please: at least ${FEEDBACK_MESSAGE_MIN} characters.`
                    : `${message.length.toLocaleString()} of ${FEEDBACK_MESSAGE_MAX.toLocaleString()}`}
              </span>
            </label>

            {needsEmail ? (
              <TextField
                label="Where can we reply?"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email || accountEmail || ''}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                hint={
                  accountEmail
                    ? 'Your account address, unless you would rather be reached elsewhere.'
                    : 'Only used to answer this message.'
                }
                data-testid="feedback-email"
              />
            ) : (
              <p className="text-body-small text-on-surface-dim">
                Sent from your account, so we can follow up at {accountEmail}.
              </p>
            )}

            {error ? (
              <p className="text-body-medium text-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={busy}
                disabled={!canSend}
                leading={<MessageSquareText size={16} />}
                data-testid="feedback-send"
              >
                {kind === 'contact' ? 'Send message' : 'Send feedback'}
              </Button>
              <span className="text-body-small text-on-surface-dim">
                Every message is read by the team.
              </span>
            </div>
          </form>
        )}
      </div>
    </ShellPage>
  );
}
