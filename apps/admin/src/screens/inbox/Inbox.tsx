import {
  FEEDBACK_KIND_LABEL,
  type FeedbackEntry,
  FeedbackKind,
  type FeedbackList,
  FeedbackStatus,
} from '@pen/contracts';
import { Button, Chip, cn, Pill, useToast } from '@pen/design';
import { Check, Eye, Mail, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { writeFailure } from '../../lib/api.js';
import { useAdmin } from '../../lib/context.js';
import { moment, planLabel } from '../../lib/format.js';
import { ConsolePage } from '../../shell/AdminShell.js';
import {
  EmptyNote,
  ReportBody,
  Section,
  StatTile,
  TableFrame,
  Td,
  Th,
  TileRow,
} from '../statistics/parts.js';
import { useReport } from '../statistics/use-report.js';

const PAGE_SIZE = 50;

/**
 * The inbox (ADR-0060): every issue, suggestion, feature request and message
 * a learner sent, newest first, with a status the operator moves. Reading a
 * row opens the whole message and a reply-by-mail link; nothing here quotes
 * the message anywhere else.
 */
export function InboxScreen() {
  const [params, setParams] = useSearchParams();
  const status = FeedbackStatus.safeParse(params.get('status'));
  const kind = FeedbackKind.safeParse(params.get('kind'));
  const page = Math.max(0, Number(params.get('page') ?? '0') || 0);
  const [version, setVersion] = useState(0);
  const toast = useToast();

  const setFilters = (changes: Record<string, string>) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [name, value] of Object.entries(changes)) {
          if (value) next.set(name, value);
          else next.delete(name);
        }
        if (!('page' in changes)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  const state = useReport(
    (api, signal) =>
      api.feedback(
        {
          ...(status.success ? { status: status.data } : {}),
          ...(kind.success ? { kind: kind.data } : {}),
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
        signal,
      ),
    [status.success ? status.data : '', kind.success ? kind.data : '', page, version],
  );

  return (
    <ConsolePage
      title="Inbox"
      intro="What learners told us: issues, suggestions, feature requests and messages. Newest first. Mark a row seen when you have read it, resolved when it is answered."
      width="wide"
    >
      <ReportBody state={state}>
        {(list) => (
          <InboxBody
            list={list}
            status={status.success ? status.data : ''}
            kind={kind.success ? kind.data : ''}
            page={page}
            setFilters={setFilters}
            onChanged={(message) => {
              toast(message, 'success');
              setVersion((v) => v + 1);
            }}
          />
        )}
      </ReportBody>
    </ConsolePage>
  );
}

function InboxBody({
  list,
  status,
  kind,
  page,
  setFilters,
  onChanged,
}: {
  list: FeedbackList;
  status: string;
  kind: string;
  page: number;
  setFilters: (changes: Record<string, string>) => void;
  onChanged: (message: string) => void;
}) {
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  return (
    <>
      <TileRow>
        <StatTile label="New" value={String(list.counts.new)} note="Not yet read" />
        <StatTile label="Seen" value={String(list.counts.seen)} note="Read, not yet answered" />
        <StatTile label="Resolved" value={String(list.counts.resolved)} note="Answered or done" />
        <StatTile
          label="All time"
          value={String(list.counts.new + list.counts.seen + list.counts.resolved)}
          note="Every submission kept"
        />
      </TileRow>

      <Section title="Submissions" note={`${list.total} in this view.`}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(['', 'new', 'seen', 'resolved'] as const).map((s) => (
            <Chip
              key={s || 'all'}
              selected={status === s}
              onClick={() => setFilters({ status: s })}
            >
              {s === '' ? 'Every status' : s === 'new' ? 'New' : s === 'seen' ? 'Seen' : 'Resolved'}
            </Chip>
          ))}
          <span className="mx-1 text-on-surface-dim" aria-hidden>
            ·
          </span>
          <Chip selected={kind === ''} onClick={() => setFilters({ kind: '' })}>
            Every kind
          </Chip>
          {FeedbackKind.options.map((k) => (
            <Chip key={k} selected={kind === k} onClick={() => setFilters({ kind: k })}>
              {FEEDBACK_KIND_LABEL[k]}
            </Chip>
          ))}
        </div>

        {list.feedback.length === 0 ? (
          <EmptyNote>Nothing here. When a learner writes to us, it lands in this list.</EmptyNote>
        ) : (
          <TableFrame>
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>Kind</Th>
                <Th>From</Th>
                <Th>Message</Th>
                <Th>Status</Th>
                <Th className="w-[1%]">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.feedback.map((f) => (
                <InboxRow key={f.id} entry={f} onChanged={onChanged} />
              ))}
            </tbody>
          </TableFrame>
        )}

        {pages > 1 ? (
          <div className="mt-4 flex items-center justify-between text-body-small text-on-surface-variant">
            <span>
              Page {page + 1} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page === 0}
                onClick={() => setFilters({ page: String(page - 1) })}
              >
                Newer
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page + 1 >= pages}
                onClick={() => setFilters({ page: String(page + 1) })}
              >
                Older
              </Button>
            </div>
          </div>
        ) : null}
      </Section>
    </>
  );
}

function InboxRow({
  entry,
  onChanged,
}: {
  entry: FeedbackEntry;
  onChanged: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const received = moment(entry.createdAt);
  const who =
    entry.name ??
    entry.participantName ??
    (entry.participantAnonymous === false ? 'An account' : 'A visitor');
  const { api } = useAdmin();

  const move = async (status: FeedbackEntry['status']) => {
    setBusy(true);
    try {
      await api.updateFeedback(entry.id, { status });
      onChanged(
        status === 'resolved'
          ? 'Marked resolved.'
          : status === 'seen'
            ? 'Marked seen.'
            : 'Reopened.',
      );
    } catch (error) {
      onChanged(writeFailure(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr
        className={cn('cursor-pointer align-top', entry.status === 'new' && 'font-medium')}
        onClick={() => setOpen((o) => !o)}
        data-testid={`inbox-row-${entry.id}`}
        aria-expanded={open}
      >
        <Td className="whitespace-nowrap">
          <time dateTime={received.iso}>{received.text}</time>
        </Td>
        <Td className="whitespace-nowrap">{FEEDBACK_KIND_LABEL[entry.kind]}</Td>
        <Td className="whitespace-nowrap">
          <span>{who}</span>
          {entry.participantPlan ? (
            <span className="ml-2 text-body-small text-on-surface-dim">
              {planLabel(entry.participantPlan)}
            </span>
          ) : null}
        </Td>
        <Td className="max-w-[28rem]">
          <span className={cn('block', !open && 'truncate')}>{entry.message}</span>
        </Td>
        <Td className="whitespace-nowrap">
          <Pill
            tone={
              entry.status === 'new' ? 'accent' : entry.status === 'resolved' ? 'neutral' : 'warm'
            }
          >
            {entry.status}
          </Pill>
        </Td>
        <Td className="whitespace-nowrap">
          <div className="flex gap-1">
            {entry.status === 'new' ? (
              <Button
                variant="ghost"
                size="sm"
                leading={<Eye size={14} />}
                loading={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void move('seen');
                }}
              >
                Seen
              </Button>
            ) : null}
            {entry.status !== 'resolved' ? (
              <Button
                variant="secondary"
                size="sm"
                leading={<Check size={14} />}
                loading={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void move('resolved');
                }}
                data-testid={`inbox-resolve-${entry.id}`}
              >
                Resolve
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                leading={<RotateCcw size={14} />}
                loading={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void move('seen');
                }}
              >
                Reopen
              </Button>
            )}
          </div>
        </Td>
      </tr>
      {open ? (
        <tr data-testid={`inbox-detail-${entry.id}`}>
          <Td className="bg-surface-container-low">{null}</Td>
          <Td className="bg-surface-container-low">{null}</Td>
          <Td className="bg-surface-container-low whitespace-nowrap">
            <div className="flex flex-col gap-1 text-body-small text-on-surface-variant">
              {entry.email ? (
                <a
                  className="inline-flex items-center gap-1 text-primary underline"
                  href={`mailto:${entry.email}?subject=${encodeURIComponent(`Re: your ${FEEDBACK_KIND_LABEL[entry.kind].toLowerCase()} to Pen Playground`)}`}
                >
                  <Mail size={13} aria-hidden /> {entry.email}
                </a>
              ) : (
                <span>No reply address</span>
              )}
              {entry.participantId ? (
                <a
                  className="text-primary underline"
                  href={`/statistics/people/${encodeURIComponent(entry.participantId)}`}
                >
                  Their page
                </a>
              ) : (
                <span>Account since deleted</span>
              )}
            </div>
          </Td>
          <Td className="bg-surface-container-low">
            <p className="whitespace-pre-wrap text-body-medium text-on-surface" dir="auto">
              {entry.message}
            </p>
            <p className="mt-2 text-body-small text-on-surface-dim">
              Sent from {entry.screen ?? 'the app'} on {entry.platform ?? 'web'}
              {entry.environment ? `, ${entry.environment}` : ''}
              {entry.release ? ` (${entry.release.slice(0, 7)})` : ''}.
              {entry.adminNote ? ` Note: ${entry.adminNote}` : ''}
            </p>
          </Td>
          <Td className="bg-surface-container-low">{null}</Td>
          <Td className="bg-surface-container-low">{null}</Td>
        </tr>
      ) : null}
    </>
  );
}
