import {
  SURVEY_OPTIONS,
  SURVEY_OTHER_MAX,
  SURVEY_QUESTION,
  SURVEY_SKIPPED,
  type SurveyKind,
  type SurveyTrigger,
} from '@pen/contracts';
import { Button, cn, Dialog } from '@pen/design';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';

/**
 * One question, one list, one step (ADR-0060). The learner picks an option
 * (or "Other" and a few words), presses Continue, and the dialog is gone;
 * Skip is small and always there. Both answers are recorded so the question
 * is not asked twice. The dialog never blocks what the learner came to do:
 * `onDone` fires after either, and after a failure to record as well, so the
 * page continues either way.
 */
export function SurveyDialog({
  open,
  kind,
  trigger,
  onDone,
}: {
  open: boolean;
  kind: SurveyKind;
  trigger: SurveyTrigger;
  /** Called once the answer or skip is recorded (or could not be); the page carries on. */
  onDone: () => void;
}) {
  const { api } = useApp();
  const [option, setOption] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) trackAction('survey_shown', { kind, trigger });
  }, [open, kind, trigger]);

  const finish = async (chosen: string) => {
    setBusy(true);
    try {
      await api.answerSurvey({
        kind,
        option: chosen,
        ...(chosen === 'other' && other.trim() ? { other: other.trim() } : {}),
        trigger,
      });
      trackAction(chosen === SURVEY_SKIPPED ? 'survey_skipped' : 'survey_answered', {
        kind,
        option: chosen,
        trigger,
      });
    } catch {
      // Recorded or not, the learner has answered; the page does not hold them for it.
    } finally {
      setBusy(false);
      onDone();
    }
  };

  const options = SURVEY_OPTIONS[kind];
  const canContinue = option !== null && (option !== 'other' || other.trim().length > 0);
  return (
    <Dialog
      open={open}
      onClose={() => void finish(SURVEY_SKIPPED)}
      title={SURVEY_QUESTION[kind]}
      width={480}
    >
      <div className="flex flex-col gap-1" role="radiogroup" aria-label={SURVEY_QUESTION[kind]}>
        {options.map((o) => {
          const chosen = option === o.id;
          return (
            <label
              key={o.id}
              className={cn(
                'state-layer flex cursor-pointer items-center justify-between rounded-md px-3.5 py-2.5 text-left text-body-large transition-colors',
                chosen ? 'bg-selected text-on-primary-fixed' : 'text-on-surface',
              )}
            >
              <input
                type="radio"
                name={`survey-${kind}`}
                value={o.id}
                checked={chosen}
                onChange={() => setOption(o.id)}
                className="sr-only"
                data-testid={`survey-option-${o.id}`}
              />
              {o.label}
              {chosen ? <Check size={16} aria-hidden /> : null}
            </label>
          );
        })}
        {option === 'other' ? (
          <input
            type="text"
            value={other}
            onChange={(e) => setOther(e.target.value.slice(0, SURVEY_OTHER_MAX))}
            placeholder="Tell us in a few words"
            maxLength={SURVEY_OTHER_MAX}
            aria-label="Tell us in a few words"
            data-testid="survey-other"
            className="mt-1 w-full rounded-md bg-surface-container-low px-3.5 py-2.5 text-body-large text-on-surface caret-primary outline-none placeholder:text-on-surface-dim shadow-[0_0_0_1px_var(--color-outline-variant)] focus:shadow-[0_0_0_2px_var(--color-outline)]"
          />
        ) : null}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void finish(SURVEY_SKIPPED)}
          disabled={busy}
          data-testid="survey-skip"
        >
          Skip
        </Button>
        <Button
          variant="primary"
          onClick={() => option && void finish(option)}
          disabled={!canContinue || busy}
          loading={busy}
          data-testid="survey-continue"
        >
          Continue
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Asks the leaving survey once per app load, for a signed-in participant
 * whose subscription has been set to end (a cancellation made in the Stripe
 * portal is only known from the webhook, so the next visit is the first
 * chance to ask). The arrival survey is the pricing page's, right after
 * checkout: asked on some later visit it would be an interruption, not a
 * question, so it is never caught up here.
 */
export function SurveyPrompt() {
  const { api, participant } = useApp();
  const [queue, setQueue] = useState<{ kind: SurveyKind; trigger: SurveyTrigger }[] | null>(null);
  const signedIn = participant !== null && !participant.anonymous;
  const id = participant?.id ?? null;
  useEffect(() => {
    if (!signedIn || !id) return;
    let cancelled = false;
    api
      .pendingSurveys()
      .then((p) => {
        if (!cancelled) setQueue(p.pending.filter((s) => s.kind === 'cancel_reason'));
      })
      .catch(() => {
        if (!cancelled) setQueue([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, signedIn, id]);
  const current = queue?.[0];
  if (!current) return null;
  return (
    <SurveyDialog
      key={`${current.kind}:${current.trigger}`}
      open
      kind={current.kind}
      trigger={current.trigger}
      onDone={() => setQueue((q) => (q ? q.slice(1) : q))}
    />
  );
}
