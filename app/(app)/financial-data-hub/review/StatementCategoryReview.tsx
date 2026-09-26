'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoneyExact } from '@/lib/engines/money';
import { ResourceErrorState, ResourceLoadingSkeleton } from '@/components/resources/admin/ResourceStates';
import { StatementDetailsDrawer } from '@/components/financial-data-hub/StatementDetailsDrawer';
// Type-only imports (erased at build): the page renders EXACTLY the
// snake_case shape the API returns, so a camelCase mismatch is a compile
// error, not a blank screen. `tests/unit/fdhCategoryReviewRoutes.test.ts`
// also pins every field this file reads against a real route response.
import type { CategoryGroup, CategoryReviewMonthTotals, NeedsDecisionItem, StatementNote, SurplusEffect } from '@/lib/financial-data-hub/domain/categoryReview';
import type { StatementCategoryReview as ReviewPayload, GroupApprovalResult, ApproveAllResult, SetCategoryResult } from '@/lib/financial-data-hub/services/categoryReviewService';

interface CategoryOption {
  id: string;
  label: string;
  economicType: string;
}

/**
 * Category-totals review of one imported bank statement (PDF or CSV — the
 * review reads the statement's saved transactions, whichever way they were
 * read). The user approves category TOTALS; only lines that genuinely need a
 * person are listed one by one.
 *
 * Money shown here is exact to the cent with its currency code, because the
 * user checks these figures against the statement in front of them (the
 * sanctioned `formatMoneyExact` case in lib/engines/money.ts).
 */

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? 'Something went wrong. Please try again.');
  return json.data as T;
}
async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? 'Something went wrong. Please try again.');
  return json.data as T;
}

function money(amount: number, currency: string): string {
  return `${formatMoneyExact(amount, currency)} ${currency}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// WP-08: the one canonical rule set (lib/read-models/core/spendingRules.ts)
// decides each group's effect; refunds reduce spending only with a confirmed
// link to the purchase (PO D-01).
const COUNTS_TOWARD_TEXT: Record<SurplusEffect, string> = {
  income: 'Counts as income',
  spending: 'Counts as spending',
  reduces_spending: 'Refund linked to its purchase: reduces your spending',
  refund_unlinked: 'Refund not linked to a purchase: not taken off your spending',
  not_counted: 'Not counted as income or spending',
  split: 'Counted by its split lines',
};

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** EXP-G3 copy: which month each figure lands in, and how the dashboard uses
 * it (the average of the last 3 complete months a statement fully covers). */
function MonthFigures({ months, approvedOnly }: { months: CategoryReviewMonthTotals[]; approvedOnly: boolean }) {
  const rows = months.filter((m) => (approvedOnly
    ? m.approved_income !== 0 || m.approved_spending !== 0
    : m.approved_income !== 0 || m.approved_spending !== 0 || m.waiting_income !== 0 || m.waiting_spending !== 0));
  if (rows.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm text-ink">
      {rows.map((m) => (
        <li key={`${m.month}-${m.currency}`}>
          <span className="font-medium">{monthLabel(m.month)}:</span>{' '}
          approved income {money(m.approved_income, m.currency)}, approved spending {money(m.approved_spending, m.currency)}
          {!approvedOnly && (m.waiting_income !== 0 || m.waiting_spending !== 0)
            ? `; once you approve the rest: income ${money(m.waiting_income, m.currency)}, spending ${money(m.waiting_spending, m.currency)} more`
            : ''}
          .
        </li>
      ))}
    </ul>
  );
}

const DASHBOARD_BASIS_TEXT =
  'Approved figures become the actual income and spending for the month they are dated in. Your dashboard uses the average of the last 3 complete months that your approved statements fully cover, so a statement that covers only part of a month is shown but not averaged.';

const OPTION_GROUPS: Array<{ label: string; types: readonly string[] }> = [
  { label: 'Spending', types: ['expense', 'fee', 'tax', 'debt_interest'] },
  { label: 'Income', types: ['income'] },
  { label: 'Refunds', types: ['refund'] },
  {
    label: 'Not counted as spending (transfers, savings, loans, cash)',
    types: ['transfer', 'investment', 'debt_principal', 'asset_purchase', 'asset_sale', 'cash_withdrawal'],
  },
];

function formatPeriod(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  if (start && end) return `${start} to ${end}`;
  return start ?? end;
}

export function StatementCategoryReview({
  statementId,
  categories,
  backHref,
  backLabel,
  fromParam,
}: {
  statementId: string;
  categories: CategoryOption[];
  backHref: string;
  backLabel: string;
  fromParam: string;
}) {
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  // After an action the line or button the user was on may disappear; focus
  // moves to the result message so keyboard and screen-reader users are not
  // left on a detached element.
  const statusRef = useRef<HTMLParagraphElement>(null);

  const url = `/api/financial-data-hub/documents/${encodeURIComponent(statementId)}/category-review`;

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      setReview(await apiGet<ReviewPayload>(url));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'We could not load this statement.');
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<ReviewPayload>(url);
        if (!cancelled) setReview(data);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'We could not load this statement.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  async function run(key: string, action: () => Promise<string>) {
    setBusy(key);
    setActionError(null);
    try {
      const message = await action();
      await reload();
      setAnnouncement(message);
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  function chosenCategory(item: NeedsDecisionItem): string {
    return choices[item.id] ?? item.suggested_category_id ?? item.current_category_id ?? '';
  }

  function saveCategory(item: NeedsDecisionItem) {
    const categoryId = chosenCategory(item);
    if (!categoryId) {
      setActionError('Choose a category first.');
      return;
    }
    const label = categories.find((c) => c.id === categoryId)?.label ?? 'the chosen category';
    const rememberPayee = remember[item.id] ?? false; // off unless the user ticks it (R8 spec 47: personal rules only from deliberate action; PO 2026-09-26)
    void run(`cat:${item.id}`, async () => {
      const result = await apiPost<SetCategoryResult>(`/api/financial-data-hub/bank-transactions/${item.id}/set-category`, {
        category_id: categoryId,
        remember_payee: rememberPayee,
      });
      return `Saved. "${item.description ?? 'This transaction'}" is now ${label}.${result.payee_remembered ? ' We will remember this payee next time.' : ''}`;
    });
  }

  function approveGroup(group: CategoryGroup) {
    void run(`group:${group.group_key}`, async () => {
      const result = await apiPost<GroupApprovalResult>(`${url}/approve-group`, { group_key: group.group_key });
      if (result.outcome === 'already_approved') return `${group.label} was already approved. Nothing changed.`;
      let message = `Approved ${group.label}: ${plural(result.approved, 'transaction', 'transactions')}.`;
      if (result.failed > 0) message += ` ${plural(result.failed, 'transaction', 'transactions')} could not be approved yet and ${result.failed === 1 ? 'is' : 'are'} listed above.`;
      if (result.statement_finalised) message += ' Every transaction on this statement is now approved.';
      else if (result.statement_not_finalised_reason) message += ` ${result.statement_not_finalised_reason}`;
      return message;
    });
  }

  function acknowledge(note: StatementNote) {
    void run(`note:${note.id}`, async () => {
      await apiPost<{ acknowledged: boolean }>(`/api/financial-data-hub/documents/${encodeURIComponent(statementId)}/review-items/${encodeURIComponent(note.id)}/acknowledge`, {});
      return 'Thank you. You confirmed every transaction on this statement is listed.';
    });
  }

  function approveAll() {
    void run('all', async () => {
      const result = await apiPost<ApproveAllResult>(`${url}/approve-all`, {});
      return result.outcome === 'already_approved'
        ? 'Everything on this statement was already approved. Nothing changed.'
        : `Approved ${plural(result.approved, 'transaction', 'transactions')}. They now count as actual income and spending for the months they are dated in.`;
    });
  }

  if (loading) return <ResourceLoadingSkeleton rows={4} />;
  if (loadError || !review) return <ResourceErrorState message={loadError ?? 'We could not load this statement.'} onRetry={() => { void reload(); }} />;

  const { counts, totals, groups, needs_decision: needsDecision, statement, months, notes } = review;
  const period = formatPeriod(statement.period_start, statement.period_end);
  const allApproved = counts.transactions > 0 && counts.waiting_for_approval === 0;
  const readyToApprove = counts.ready_to_approve;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-ink">Review your statement by category</h1>
        <p className="mt-1 text-sm text-muted">
          {period ? `Statement period ${period}. ` : ''}
          Check the total for each category and approve it. You only need to look at single transactions when we could
          not tell what they are.
        </p>
        <StatementDetailsDrawer statementId={statement.id} />
      </div>

      {notes.length > 0 && (
        <section aria-labelledby="notes-heading" className="space-y-2 rounded-compact border border-line bg-white p-4">
          <h2 id="notes-heading" className="text-base font-semibold text-ink">About this statement</h2>
          <ul className="space-y-2">
            {notes.map((note) => (
              <li key={note.id} className={note.severity === 'blocking' ? 'rounded-compact bg-risk/10 px-3 py-2 text-sm text-ink' : 'rounded-compact bg-trust/5 px-3 py-2 text-sm text-ink'}>
                <p>{note.text}</p>
                {note.can_acknowledge && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => acknowledge(note)}
                    className="mt-2 rounded-compact border border-trust px-3 py-1 text-sm font-semibold text-trust disabled:opacity-50"
                  >
                    I have checked: every transaction is listed
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className={announcement ? 'rounded-compact bg-positive/10 px-3 py-2 text-sm text-positive' : 'sr-only'}>
        {announcement}
      </p>
      {actionError && (
        <p role="alert" className="rounded-compact bg-risk/10 px-3 py-2 text-sm text-risk">{actionError}</p>
      )}

      {/* Summary */}
      <section aria-labelledby="summary-heading" className="rounded-compact border border-line bg-white p-4">
        <h2 id="summary-heading" className="text-base font-semibold text-ink">Summary</h2>
        {counts.transactions === 0 ? (
          <p className="mt-2 text-sm text-muted">This statement has no transactions to review.</p>
        ) : allApproved ? (
          <p className="mt-2 text-sm text-ink">
            All {plural(counts.approved, 'transaction is', 'transactions are')} approved.
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink">
            {plural(counts.waiting_for_approval, 'transaction is', 'transactions are')} waiting for your approval
            {counts.needs_decision > 0 ? `, and ${counts.needs_decision} of ${counts.needs_decision === 1 ? 'them needs' : 'them need'} you to choose a category first` : ''}.
            Nothing counts toward your income or spending until you approve it.
          </p>
        )}
        {totals.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {totals.map((t) => (
              <li key={t.currency}>
                {counts.ready_to_approve > 0 && (
                  <span className="block">
                    Will count once you approve: income {money(t.waiting_income, t.currency)}, spending {money(t.waiting_spending, t.currency)}
                    {counts.needs_decision > 0
                      ? ` (plus the ${plural(counts.needs_decision, 'transaction', 'transactions')} that still ${counts.needs_decision === 1 ? 'needs' : 'need'} a category).`
                      : '.'}
                  </span>
                )}
                {counts.approved > 0 && (
                  <span className="block">
                    Already approved: income {money(t.approved_income, t.currency)}, spending {money(t.approved_spending, t.currency)}.
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <MonthFigures months={months} approvedOnly={allApproved} />
        <p className="mt-2 text-xs text-muted">{DASHBOARD_BASIS_TEXT}</p>
        {counts.duplicates_removed > 0 && (
          <p className="mt-2 text-xs text-muted">
            {plural(counts.duplicates_removed, 'transaction was', 'transactions were')} removed as a duplicate and {counts.duplicates_removed === 1 ? 'is' : 'are'} not counted.
          </p>
        )}
        <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-compact border border-line p-2">
            <dt className="text-xs text-muted">Need your decision</dt>
            <dd className="text-lg font-semibold text-ink">{counts.needs_decision}</dd>
          </div>
          <div className="rounded-compact border border-line p-2">
            <dt className="text-xs text-muted">Ready to approve</dt>
            <dd className="text-lg font-semibold text-ink">{readyToApprove}</dd>
          </div>
          <div className="rounded-compact border border-line p-2">
            <dt className="text-xs text-muted">Approved</dt>
            <dd className="text-lg font-semibold text-ink">{counts.approved}</dd>
          </div>
        </dl>
      </section>

      {/* Lines that need a person */}
      {needsDecision.length > 0 && (
        <section aria-labelledby="decide-heading" className="rounded-compact border border-attention/40 bg-attention/5 p-4">
          <h2 id="decide-heading" className="text-base font-semibold text-ink">
            Choose a category ({needsDecision.length})
          </h2>
          <p className="mt-1 text-sm text-muted">
            We could not be sure what these are. Pick a category for each one; it then joins the matching total below.
          </p>
          <ul className="mt-3 space-y-3">
            {needsDecision.map((item) => {
              const selectId = `category-${item.id}`;
              const rememberId = `remember-${item.id}`;
              const chosen = chosenCategory(item);
              const suggested = item.suggested_category_id && item.suggested_category_id !== item.current_category_id
                ? categories.find((c) => c.id === item.suggested_category_id)?.label
                : null;
              return (
                <li key={item.id} className="rounded-compact border border-line bg-white p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{item.description ?? 'Transaction'}</p>
                    <p className="text-sm tabular-nums text-ink">
                      {item.direction === 'in' ? 'Money in ' : 'Money out '}
                      {money(item.amount, item.currency)}
                    </p>
                  </div>
                  <p className="text-xs text-muted">{item.transaction_date}</p>
                  <p className="mt-1 text-xs text-muted">{item.reason_text}</p>
                  {item.can_choose_category ? (
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <div className="flex flex-col">
                        <label htmlFor={selectId} className="text-xs font-medium text-ink">
                          Category<span className="sr-only"> for {item.description ?? 'this transaction'}</span>
                          {suggested ? ` (suggested: ${suggested})` : ''}
                        </label>
                        <select
                          id={selectId}
                          value={chosen}
                          onChange={(e) => setChoices((c) => ({ ...c, [item.id]: e.target.value }))}
                          className="mt-1 rounded-compact border border-line bg-white px-2 py-1 text-sm"
                        >
                          <option value="">Choose a category</option>
                          {OPTION_GROUPS.map((g) => {
                            const options = categories.filter((c) => g.types.includes(c.economicType));
                            if (options.length === 0) return null;
                            return (
                              <optgroup key={g.label} label={g.label}>
                                {options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                              </optgroup>
                            );
                          })}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          id={rememberId}
                          type="checkbox"
                          checked={remember[item.id] ?? false}
                          onChange={(e) => setRemember((r) => ({ ...r, [item.id]: e.target.checked }))}
                        />
                        <label htmlFor={rememberId} className="text-xs text-ink">
                          Remember this payee next time<span className="sr-only"> ({item.description ?? 'this transaction'})</span>
                        </label>
                      </div>
                      <button
                        type="button"
                        disabled={busy !== null || !chosen}
                        onClick={() => saveCategory(item)}
                        className="rounded-compact bg-trust px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        Save category<span className="sr-only"> for {item.description ?? 'this transaction'}</span>
                      </button>
                    </div>
                  ) : (
                    <Link
                      href={`/financial-data-hub/review?transaction=${item.id}&from=${fromParam}`}
                      className="mt-2 inline-block text-sm font-semibold text-trust hover:underline"
                    >
                      Open to decide
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Category totals */}
      <section aria-labelledby="groups-heading" className="space-y-3">
        <h2 id="groups-heading" className="text-base font-semibold text-ink">Category totals</h2>
        {groups.length === 0 ? (
          <p className="text-sm text-muted">
            {needsDecision.length > 0 ? 'Totals appear here once each transaction has a category.' : 'There are no categorised transactions on this statement yet.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {groups.map((group) => {
              const headingId = `group-${group.group_key.replace(/[^a-zA-Z0-9]/g, '-')}`;
              return (
                <li key={group.group_key} aria-labelledby={headingId} className="rounded-compact border border-line bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 id={headingId} className="text-sm font-semibold text-ink">
                        {group.label} <span className="font-normal text-muted">· {group.direction === 'in' ? 'Money in' : 'Money out'}</span>
                      </h3>
                      <p className="text-xs text-muted">
                        {plural(group.count, 'transaction', 'transactions')} · {COUNTS_TOWARD_TEXT[group.counts_toward]}
                      </p>
                      {group.not_counted_reason && <p className="text-xs text-muted">{group.not_counted_reason}</p>}
                      {!group.fully_confident && group.status !== 'approved' && (
                        <p className="mt-1 text-xs text-muted">Suggested from the wording on your statement. Check the total looks right.</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold tabular-nums text-ink">{money(group.total, group.currency)}</p>
                      <p className="text-xs text-muted">
                        {group.status === 'approved'
                          ? 'Approved'
                          : group.status === 'partly_approved'
                            ? `${group.approved_count} of ${group.count} approved`
                            : 'Waiting for approval'}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {group.pending_count > 0 && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => approveGroup(group)}
                        aria-label={`Approve ${group.label}, ${plural(group.pending_count, 'transaction', 'transactions')}, ${money(group.pending_total, group.currency)}`}
                        className="rounded-compact bg-trust px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        Approve {group.label}
                      </button>
                    )}
                    <details className="text-sm">
                      <summary className="cursor-pointer text-trust">Show the {plural(group.count, 'transaction', 'transactions')}</summary>
                      <ul className="mt-2 space-y-1">
                        {group.lines.map((line) => (
                          <li key={line.id} className="flex flex-wrap justify-between gap-2 border-b border-line/60 py-1">
                            <span className="text-ink">{line.transaction_date} · {line.description ?? 'Transaction'}</span>
                            <span className="tabular-nums text-ink">
                              {money(line.amount, group.currency)}
                              {line.approval_status === 'approved' ? ' · approved' : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Approve everything */}
      {!allApproved && counts.transactions > 0 && (
        <section aria-labelledby="approve-all-heading" className="rounded-compact border border-line bg-white p-4">
          <h2 id="approve-all-heading" className="text-base font-semibold text-ink">Approve everything</h2>
          {needsDecision.length > 0 ? (
            <p className="mt-1 text-sm text-muted">
              Once you have chosen a category for the {plural(needsDecision.length, 'transaction', 'transactions')} above, you can approve
              everything in one step. You can already approve each category total on its own.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted">Every transaction has a category. Approve them all at once:</p>
              <button
                type="button"
                disabled={busy !== null || readyToApprove === 0}
                onClick={() => approveAll()}
                className="mt-2 rounded-compact bg-trust px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Approve all {plural(readyToApprove, 'transaction', 'transactions')}
              </button>
            </>
          )}
        </section>
      )}

      {allApproved && (
        <section className="rounded-compact border border-positive/40 bg-positive/5 p-4">
          <h2 className="text-base font-semibold text-ink">You are done</h2>
          <p className="mt-1 text-sm text-ink">
            This statement is fully approved. Its lines are your actual income and spending for the months they are dated in.
          </p>
          <Link href={backHref} className="mt-2 inline-block text-sm font-semibold text-trust hover:underline">{backLabel}</Link>
        </section>
      )}
    </div>
  );
}
