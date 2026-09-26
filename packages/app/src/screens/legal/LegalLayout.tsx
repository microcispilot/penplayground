import { cn } from '@pen/design';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router';

/** The day these pages last changed; both pages show the same one. */
export const LEGAL_UPDATED = '25 September 2026';
export const LEGAL_CONTACT = 'support@penplayground.com';

export interface LegalSection {
  /** Anchor and table-of-contents key. */
  id: string;
  title: string;
  body: ReactNode;
}

/* ── prose primitives ──────────────────────────────────────────────────────
   Local to the legal pages: token-styled, so long-form copy stays readable in
   both themes without a typography plugin or ad-hoc colours. */

export function P({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-body-medium text-on-surface-variant text-pretty">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="mb-4 flex flex-col gap-2 text-body-medium text-on-surface-variant">
      {children}
    </ul>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-[9px] size-[5px] shrink-0 rounded-full bg-primary" aria-hidden />
      <span className="min-w-0 text-pretty">{children}</span>
    </li>
  );
}

export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-on-surface">{children}</strong>;
}

export function Mail({ address = LEGAL_CONTACT }: { address?: string }) {
  return (
    <a
      href={`mailto:${address}`}
      className="font-medium text-primary underline decoration-primary/40 underline-offset-[3px] hover:decoration-primary"
    >
      {address}
    </a>
  );
}

/** A cross-link between the legal pages, inside the prose. */
export function LegalLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className="font-medium text-primary underline decoration-primary/40 underline-offset-[3px] hover:decoration-primary"
    >
      {children}
    </NavLink>
  );
}

/** Which section the reader is in, so the table of contents can mark it. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  // The ids are a fresh array every render; the observer must outlive that.
  const key = ids.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the ids, flattened so the effect is stable
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        let best: string | null = null;
        let bestRatio = 0;
        for (const id of ids) {
          const ratio = seen.get(id) ?? 0;
          if (ratio > bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        if (best) setActive(best);
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);
  return active;
}

/**
 * The shell both legal pages share: the title, one line saying what the page
 * is, when it was last updated, and — on a wide screen — a table of contents
 * that follows the reader down the page. The measure is held at ~68
 * characters so the long copy stays readable.
 */
export function LegalLayout({
  title,
  intro,
  sections,
}: {
  title: string;
  intro: string;
  sections: LegalSection[];
}) {
  const ids = useMemo(() => sections.map((s) => s.id), [sections]);
  const active = useActiveSection(ids);

  return (
    <div className="flex-1 px-6 pt-10 pb-24 sm:px-8">
      <div className="mx-auto grid w-full max-w-[1040px] gap-12 xl:grid-cols-[minmax(0,1fr)_216px]">
        <article className="min-w-0 max-w-[68ch]">
          <h1 className="text-headline-medium text-on-surface">{title}</h1>
          <p className="mt-4 text-body-large text-on-surface-variant text-pretty">{intro}</p>
          <p className="mt-3 text-body-medium text-on-surface-dim">Last updated {LEGAL_UPDATED}</p>

          <div className="mt-10 flex flex-col">
            {sections.map((s, i) => (
              <section
                key={s.id}
                id={s.id}
                className={cn('scroll-mt-24', i > 0 && 'mt-9 border-t border-outline-variant pt-9')}
              >
                <h2 className="mb-3.5 text-title-large text-on-surface">
                  {`${i + 1}. ${s.title}`}
                </h2>
                {s.body}
              </section>
            ))}
          </div>

          <footer className="mt-12 border-t border-outline-variant pt-6 text-body-medium text-on-surface-dim">
            <p>
              Pen Playground is a product of Microcis, a California limited liability company.
              Questions about this page: <Mail />.
            </p>
            <p className="mt-2 flex flex-wrap gap-x-2">
              <LegalLink to="/terms">Terms of Use</LegalLink>
              <span aria-hidden>·</span>
              <LegalLink to="/privacy">Privacy Policy</LegalLink>
              <span aria-hidden>·</span>
              <LegalLink to="/refunds">Cancellation and Refunds</LegalLink>
            </p>
          </footer>
        </article>

        <nav aria-label="On this page" className="hidden xl:block">
          <div className="sticky top-24">
            <p className="mb-3 text-label-small font-semibold tracking-wider text-on-surface-dim uppercase">
              On this page
            </p>
            <ul className="flex flex-col gap-0.5 border-l border-outline-variant">
              {sections.map((s, i) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    aria-current={active === s.id ? 'true' : undefined}
                    className={cn(
                      '-ml-px block border-l py-1.5 pl-3 text-body-medium transition-colors',
                      active === s.id
                        ? 'border-primary font-medium text-primary'
                        : 'border-transparent text-on-surface-dim hover:border-outline hover:text-on-surface-variant',
                    )}
                  >
                    {`${i + 1}. ${s.title}`}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>
    </div>
  );
}
