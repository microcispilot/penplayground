import type { Expert } from '@pen/contracts';
import { Chip, cn, Skeleton } from '@pen/design';
import { ArrowUpRight, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ShellPage } from '../components/AppShell.js';
import { TOPIC_DOMAINS } from '../components/Sidebar.js';
import { useApp } from '../lib/context.js';

const DOMAIN_LABEL = new Map(TOPIC_DOMAINS.map((d) => [d.id, d.label]));

/**
 * The whole catalog, filterable by domain and by name. Picking one is not a
 * detail page — it is the start of a lesson: the learner lands back on Home
 * with that expert already chosen in the command bar, which is the single
 * gesture the product is built around.
 */
export function Experts() {
  const { api } = useApp();
  const navigate = useNavigate();
  const [experts, setExperts] = useState<Expert[] | null>(null);
  const [domain, setDomain] = useState('all');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .listExperts()
      .then((e) => {
        if (!cancelled) setExperts(e);
      })
      .catch(() => {
        if (!cancelled) setExperts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const domains = useMemo(() => {
    const present = new Set((experts ?? []).map((e) => e.domain));
    return TOPIC_DOMAINS.filter((d) => present.has(d.id));
  }, [experts]);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (experts ?? []).filter(
      (e) =>
        (domain === 'all' || e.domain === domain) &&
        (!f || `${e.displayName} ${e.role} ${e.specialties.join(' ')}`.toLowerCase().includes(f)),
    );
  }, [experts, domain, filter]);

  const choose = (expert: Expert) => {
    // Home owns the command bar; it reads this and fills the chip in.
    navigate('/', { state: { expertId: expert.id } });
  };

  return (
    <ShellPage
      title="Experts"
      intro={
        experts === null
          ? 'Every expert Pen Playground can teach with.'
          : `${experts.length} experts across science, code, medicine, law, money and the arts. Pick one and they are ready to teach.`
      }
      actions={
        <label className="flex h-9 w-[240px] shrink-0 items-center gap-2 rounded-full bg-bg-elevated px-3.5 hairline">
          <Search size={14} className="shrink-0 text-fg-3" aria-hidden />
          <input
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
            placeholder="Filter experts"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter experts"
          />
        </label>
      }
    >
      <fieldset className="mb-7 flex flex-wrap gap-1.5 border-0 p-0">
        <legend className="sr-only">Filter by domain</legend>
        <Chip selected={domain === 'all'} onClick={() => setDomain('all')}>
          All
        </Chip>
        {domains.map((d) => (
          <Chip key={d.id} selected={domain === d.id} onClick={() => setDomain(d.id)}>
            {d.label}
          </Chip>
        ))}
      </fieldset>

      <div
        className="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(178px,1fr))]"
        data-testid="experts-grid"
      >
        {experts === null
          ? Array.from({ length: 12 }, (_, i) => `sk-${i}`).map((k) => (
              <Skeleton key={k} className="aspect-[4/5] rounded-[var(--radius-xl)]" />
            ))
          : visible.map((e) => (
              <ExpertTile
                key={e.id}
                expert={e}
                portraitUrl={api.portraitUrl(e.portrait?.src)}
                onChoose={() => choose(e)}
              />
            ))}
      </div>

      {experts !== null && visible.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-20 text-center">
          <p className="text-md text-fg">No experts match.</p>
          <p className="text-sm text-fg-2">Try another domain, or clear the filter.</p>
        </div>
      ) : null}
    </ShellPage>
  );
}

function ExpertTile({
  expert,
  portraitUrl,
  onChoose,
}: {
  expert: Expert;
  portraitUrl: string | null;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      data-testid="expert-tile"
      title={`Learn with ${expert.displayName}`}
      className={cn(
        'group relative aspect-[4/5] overflow-hidden rounded-[var(--radius-xl)] bg-surface-2 text-left shadow-card',
        'transition-[transform,box-shadow] duration-[var(--duration-slow)] ease-[var(--ease-out)] hover:-translate-y-1 hover:shadow-lift',
      )}
    >
      {portraitUrl ? (
        <img
          src={portraitUrl}
          alt={expert.portrait?.alt ?? expert.displayName}
          loading="lazy"
          className="absolute inset-0 size-full object-cover transition-transform duration-[600ms] ease-[var(--ease-out)] group-hover:scale-[1.04]"
        />
      ) : null}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[62%]"
        style={{
          background:
            'linear-gradient(to top, oklch(0.2 0.05 248 / 93%), oklch(0.2 0.05 248 / 0%))',
        }}
      />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-3.5 text-white">
        <span className="text-[15px] font-medium leading-tight tracking-[-0.01em]">
          {expert.displayName}
        </span>
        <span className="line-clamp-2 text-[12px] leading-snug text-white/75">{expert.role}</span>
        <span className="mt-1 text-[11px] text-white/60">
          {DOMAIN_LABEL.get(expert.domain) ?? 'Other'}
        </span>
      </div>
      <span className="absolute top-2.5 right-2.5 grid size-8 place-items-center rounded-full bg-white/15 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        <ArrowUpRight size={15} />
      </span>
    </button>
  );
}
