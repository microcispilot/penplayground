import type { Expert } from '@pen/contracts';
import { Chip, Skeleton } from '@pen/design';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ShellPage } from '../components/AppShell.js';
import { ExpertCard } from '../components/ExpertCard.js';
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
          : `${experts.length} experts across science, software, coding, medicine, law, money, arts, and more. They can teach you in your language.`
      }
      actions={
        <label className="flex h-9 w-[240px] shrink-0 items-center gap-2 rounded-full bg-surface-container px-3.5 hairline">
          <Search size={14} className="shrink-0 text-on-surface-dim" aria-hidden />
          <input
            className="min-w-0 flex-1 bg-transparent text-body-medium text-on-surface outline-none placeholder:text-on-surface-dim"
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
              <Skeleton key={k} className="aspect-[4/5] rounded-xl" />
            ))
          : visible.map((e) => (
              <ExpertCard
                key={e.id}
                expert={e}
                // A tile is ~178–220 px wide: the w192 variant, like every other
                // portrait in the product. The w384 file is for the hero only.
                portraitUrl={api.portraitUrl(e.portrait?.src, 192)}
                domainLabel={DOMAIN_LABEL.get(e.domain) ?? 'Other'}
                onChoose={() => choose(e)}
              />
            ))}
      </div>

      {experts !== null && visible.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-20 text-center">
          <p className="text-body-large text-on-surface">No experts match.</p>
          <p className="text-body-medium text-on-surface-variant">
            Try another domain, or clear the filter.
          </p>
        </div>
      ) : null}
    </ShellPage>
  );
}
