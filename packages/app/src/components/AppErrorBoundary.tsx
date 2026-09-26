import { Button, PenMark } from '@pen/design';
import { RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError, trackAction } from '../lib/analytics.js';
import { applySeo } from '../lib/seo.js';

/**
 * The last screen between a render crash and a white page. It captures the
 * failure through the Monitor seam (Sentry in the hosts, content-free as
 * everywhere else), shows the reference id so a report can be traced to the
 * issue, and offers the one thing that usually works: try again.
 *
 * `onError` is the test seam; the hosts leave it out and the monitor from
 * `initAnalytics` is used.
 */
export interface AppErrorBoundaryProps {
  children: ReactNode;
  /** Capture the failure and return the monitor's reference id (or null). */
  onError?: (error: unknown, info: { componentStack: string }) => string | null;
  /**
   * Where "Back to Explore" reloads to. This is a full document load, outside
   * the router, so it is the one link in the product that has to spell the
   * app's base path itself; `PenApp` passes it. Defaults to the origin root.
   */
  homeHref?: string;
}

interface State {
  failed: boolean;
  /** Sentry event id; null when no monitor is configured (local development). */
  ref: string | null;
  /** Bumped on "Try again" so the subtree remounts from scratch rather than replaying its state. */
  attempt: number;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, State> {
  override state: State = { failed: false, ref: null, attempt: 0 };

  static getDerivedStateFromError(): Pick<State, 'failed'> {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const capture =
      this.props.onError ??
      ((e: unknown, i: { componentStack: string }) =>
        reportClientError('app.render', e, i.componentStack ? 'render' : undefined));
    let ref: string | null = null;
    try {
      ref = capture(error, { componentStack: info.componentStack ?? '' });
    } catch {
      // Reporting must never be the reason the fallback does not render.
    }
    this.setState({ ref });
    applySeo({ title: 'Something went wrong', noindex: true });
  }

  private retry = (): void => {
    trackAction('retry_clicked', { attempt: this.state.attempt + 1 });
    this.setState((s) => ({ failed: false, ref: null, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    if (!this.state.failed) return <div key={this.state.attempt}>{this.props.children}</div>;
    return (
      <ErrorScreen
        reference={this.state.ref}
        onRetry={this.retry}
        homeHref={this.props.homeHref ?? '/'}
      />
    );
  }
}

/** The fallback itself, exported so it can be looked at (and tested) on its own. */
export function ErrorScreen({
  reference,
  onRetry,
  homeHref = '/',
}: {
  reference: string | null;
  onRetry: () => void;
  /** The app's own root, base path included (see `AppErrorBoundaryProps`). */
  homeHref?: string;
}) {
  return (
    <div
      className="grid min-h-screen place-items-center bg-surface px-6"
      data-testid="error-screen"
    >
      <div className="flex w-full max-w-[28.75rem] flex-col items-center text-center">
        <span className="animate-rise mb-6 grid size-14 place-items-center rounded-lg-increased bg-surface-container text-on-surface shadow-level2">
          <PenMark size={28} />
        </span>
        <h1 className="animate-rise text-headline-small text-on-surface text-pretty">
          This screen stopped drawing
        </h1>
        <p className="animate-rise mt-3 max-w-[23.75rem] text-title-small text-on-surface-variant text-pretty">
          Something in the page gave up halfway. Nothing you did caused it, and your sessions are
          safe. Try it again — it usually comes back.
        </p>
        <div className="animate-rise mt-7 flex items-center gap-2">
          <Button variant="primary" size="lg" leading={<RotateCcw size={15} />} onClick={onRetry}>
            Try again
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              // A full load, not a route change: whatever broke is not in the next document.
              if (typeof window !== 'undefined') window.location.assign(homeHref);
            }}
          >
            Back to Explore
          </Button>
        </div>
        {reference ? (
          <p className="animate-rise mt-6 text-body-small text-on-surface-dim">
            If it keeps happening, this is where we look:{' '}
            <code
              className="rounded-sm bg-surface-container-high px-1.5 py-0.5 font-mono text-body-small text-on-surface-variant"
              data-testid="error-reference"
            >
              {reference}
            </code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
