import { Button, cn, Dialog, useToast } from '@pen/design';
import { Check, Download } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../lib/context.js';
import { WHAT_IS_COLLECTED, WHAT_IS_NEVER_COLLECTED } from '../lib/privacy.js';

/**
 * Privacy choices (ADR-0017).
 *
 * Not a consent wall — it is never in anyone's way, and nothing here is asked
 * before a lesson can start. It exists because someone who wants to know what
 * leaves their machine deserves a plain answer and a switch, not a policy page
 * and a cookie banner. Analytics here are cookieless and content-free and ads
 * are non-personalised, which is why this is a preference rather than a
 * question.
 */
export function PrivacyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { privacy, setPrivacy, api } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      await setPrivacy({ analytics: !privacy.analytics });
      toast(privacy.analytics ? 'Analytics off' : 'Analytics on', 'success');
    } finally {
      setBusy(false);
    }
  };

  /** The learner's own copy of everything this deployment holds about them. */
  const download = async () => {
    setDownloading(true);
    try {
      const data = await api.myData();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pen-playground-my-data.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not prepare your data', 'danger');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Privacy choices">
      <p className="text-[15px] leading-[1.55] text-fg-2 text-pretty">
        We keep this simple: no tracking cookies, no advertising profile, and nothing you say or
        write ever leaves your session. Here is the whole of it.
      </p>

      <div className="mt-5 flex items-center justify-between gap-4 rounded-[var(--radius-lg)] bg-surface-2 p-4">
        <div className="min-w-0">
          <p className="font-medium">Product analytics</p>
          <p className="mt-0.5 text-sm text-fg-2 text-pretty">
            Anonymous counts and timings that tell us what to fix. Cookieless — nothing is stored on
            this device to recognise you later.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={privacy.analytics}
          aria-label="Product analytics"
          disabled={busy}
          onClick={() => void toggle()}
          data-testid="analytics-switch"
          className={cn(
            'relative h-7 w-12 shrink-0 rounded-full transition-colors duration-[var(--duration-fast)]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            privacy.analytics ? 'bg-accent' : 'bg-line-strong',
          )}
        >
          <span
            className={cn(
              'absolute top-1 size-5 rounded-full bg-bg-elevated shadow-float transition-[left] duration-[var(--duration-base)] ease-[var(--ease-out)]',
              privacy.analytics ? 'left-6' : 'left-1',
            )}
          />
        </button>
      </div>

      <section className="mt-5">
        <h4 className="text-sm font-medium text-fg">What we collect</h4>
        <ul className="mt-2 flex flex-col gap-1.5">
          {WHAT_IS_COLLECTED.map((line) => (
            <li key={line} className="flex gap-2 text-sm text-fg-2">
              <Check size={14} className="mt-[3px] shrink-0 text-accent" aria-hidden />
              <span className="text-pretty">{line}</span>
            </li>
          ))}
        </ul>
        <h4 className="mt-4 text-sm font-medium text-fg">What we never collect</h4>
        <ul className="mt-2 flex flex-col gap-1.5">
          {WHAT_IS_NEVER_COLLECTED.map((line) => (
            <li key={line} className="text-sm text-fg-2 text-pretty">
              {line}
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          leading={<Download size={14} />}
          loading={downloading}
          onClick={() => void download()}
        >
          Download my data
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
