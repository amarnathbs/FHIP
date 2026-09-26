'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatMoney, formatMoneyCode } from '@/lib/engines/money';
import { ResourceEmptyState, ResourceErrorState, ResourceLoadingSkeleton } from '@/components/resources/admin/ResourceStates';
// WP-08: rows removed as a duplicate count nowhere and are never approved --
// the canonical rule, not a copy (spendingRules is pure and client-safe).
import { isDuplicateExcluded } from '@/lib/read-models/core/spendingRules';
import { SplitTransactionEditor } from './SplitTransactionEditor';

// Mirrors lib/financial-data-hub/constants/enums.ts FDH_ECONOMIC_TRANSACTION_TYPES
// (kept as a plain literal list here rather than importing the server-only
// enums module into a client component — this file never invents a new
// value, only renders the existing closed set as select options).
const ECONOMIC_TYPES = [
  'income', 'expense', 'transfer', 'investment', 'debt_principal', 'debt_interest',
  'refund', 'asset_purchase', 'asset_sale', 'tax', 'fee', 'cash_withdrawal', 'unknown',
] as const;

interface CategoryOption {
  id: string;
  label: string;
  economicType: string;
}

interface QueueItem {
  id: string;
  financial_account_id: string;
  statement_upload_id: string | null;
  transaction_date: string;
  description_clean: string | null;
  amount_original: number;
  currency_original: string;
  credit_debit: 'credit' | 'debit';
  economic_transaction_type: string;
  category_id: string | null;
  review_status: string;
  approval_status: string;
  classification_confidence: number | null;
}

/** Exactly the snake_case keys `GET /api/financial-data-hub/review-queue`
 * returns (pinned by tests/unit/fdhCategoryReviewRoutes.test.ts). */
export interface QueueSections {
  needs_attention: number;
  transfers: number;
  possible_duplicates: number;
  uncategorised: number;
  low_confidence: number;
  recurring_candidates: number;
  awaiting_approval: number;
  ready_to_approve: number;
}

export interface QueueStatement {
  id: string;
  period_start: string | null;
  period_end: string | null;
  file_name: string | null;
  waiting: number;
}

interface QueueResponse {
  items: QueueItem[];
  sections: QueueSections;
  statements: QueueStatement[];
}

/** Tiles whose number is exactly the length of the list they open. */
const FILTER_TILES: Array<{ key: keyof QueueSections; reason: string; label: string }> = [
  { key: 'needs_attention', reason: 'needs_attention', label: 'Need a decision' },
  { key: 'uncategorised', reason: 'uncategorised', label: 'No category yet' },
  { key: 'low_confidence', reason: 'low_confidence', label: 'Not sure of the category' },
  { key: 'transfers', reason: 'transfers', label: 'Possible transfers' },
  { key: 'possible_duplicates', reason: 'duplicates', label: 'Possible duplicates' },
  { key: 'awaiting_approval', reason: 'awaiting_approval', label: 'Waiting for approval' },
];

const TYPE_LABEL: Record<string, string> = {
  income: 'Income', expense: 'Spending', transfer: 'Transfer', investment: 'Investment', debt_principal: 'Loan repayment',
  debt_interest: 'Interest', refund: 'Refund', asset_purchase: 'Investment purchase', asset_sale: 'Investment sale',
  tax: 'Tax', fee: 'Fee', cash_withdrawal: 'Cash withdrawal', unknown: 'No category yet',
};

interface TxnDetail {
  id: string;
  financial_account_id: string;
  transaction_date: string;
  description_clean: string | null;
  amount_original: number;
  currency_original: string;
  credit_debit: 'credit' | 'debit';
  economic_transaction_type: string;
  category_id: string | null;
  subcategory_id: string | null;
  merchant_id: string | null;
  dedup_status: string;
  review_status: string;
  approval_status: string;
}

interface LinkRow {
  id: string;
  transaction_id_from: string;
  transaction_id_to: string | null;
  link_type: string;
  status: string;
  confidence: number | null;
  user_confirmed: boolean;
}

interface DuplicateRow {
  id: string;
  transaction_id_a: string;
  transaction_id_b: string;
  match_method: string;
  status: string;
  reason_code: string | null;
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `request failed (${res.status})`);
  return json.data as T;
}
async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `request failed (${res.status})`);
  return json.data as T;
}

const REASON_LABEL: Record<string, string> = {
  needs_attention: 'Need a decision',
  transfers: 'Possible transfers',
  duplicates: 'Possible duplicates',
  uncategorised: 'No category yet',
  low_confidence: 'Not sure of the category',
  awaiting_approval: 'Waiting for approval',
};

function queueUrl(accountId: string | null, reason: string | null): string {
  const qs = new URLSearchParams();
  if (accountId) qs.set('account_id', accountId);
  if (reason && REASON_LABEL[reason]) qs.set('reason', reason);
  const s = qs.toString();
  return `/api/financial-data-hub/review-queue${s ? `?${s}` : ''}`;
}

export function ReviewWorkspace({
  initialTransactionId,
  initialReason,
  initialAccountId,
  fromParam,
  categories,
}: {
  initialTransactionId: string | null;
  initialReason: string | null;
  initialAccountId: string | null;
  fromParam: string;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [sections, setSections] = useState<QueueSections | null>(null);
  const [statements, setStatements] = useState<QueueStatement[]>([]);
  const [reason, setReason] = useState<string | null>(initialReason && REASON_LABEL[initialReason] ? initialReason : null);

  const [focusedId, setFocusedId] = useState<string | null>(initialTransactionId);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);
  const [txn, setTxn] = useState<TxnDetail | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateRow[]>([]);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [correctionField, setCorrectionField] = useState<'category_id' | 'economic_transaction_type'>('category_id');
  const [correctionValue, setCorrectionValue] = useState('');

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const data = await apiGet<QueueResponse>(queueUrl(initialAccountId, reason));
      setItems(data.items);
      setSections(data.sections);
      setStatements(data.statements ?? []);
    } catch (e) {
      setQueueError(e instanceof Error ? e.message : 'Could not load the review queue.');
    } finally {
      setQueueLoading(false);
    }
  }, [initialAccountId, reason]);

  const loadFocused = useCallback(async (id: string) => {
    setFocusLoading(true);
    setFocusError(null);
    setActionMessage(null);
    try {
      const [t, l, d] = await Promise.all([
        apiGet<TxnDetail>(`/api/financial-data-hub/bank-transactions/${id}`),
        apiGet<{ links: LinkRow[] }>(`/api/financial-data-hub/transaction-links?transaction_id=${id}`),
        apiGet<{ candidates: DuplicateRow[] }>(`/api/financial-data-hub/duplicate-candidates?transaction_id=${id}`),
      ]);
      setTxn(t);
      setLinks(l.links);
      setDuplicates(d.candidates);
      setCorrectionValue(t.category_id ?? '');
    } catch (e) {
      setFocusError(e instanceof Error ? e.message : 'Could not load this transaction.');
    } finally {
      setFocusLoading(false);
    }
  }, []);

  // Each mount/param-change effect below re-does its fetch inline (rather
  // than calling the loadX() function by reference) with a `cancelled`
  // guard before every setState — the accepted pattern this codebase uses
  // for the react-hooks/set-state-in-effect rule (see
  // components/investment-intelligence/InvestmentIntelligenceClient.tsx).
  // loadQueue/loadFocused themselves are still reused
  // directly by the retry buttons and post-action refresh below, where
  // calling them is not subject to this rule.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setQueueLoading(true);
      setQueueError(null);
      try {
        const data = await apiGet<QueueResponse>(queueUrl(initialAccountId, reason));
        if (cancelled) return;
        setItems(data.items);
        setSections(data.sections);
        setStatements(data.statements ?? []);
      } catch (e) {
        if (!cancelled) setQueueError(e instanceof Error ? e.message : 'Could not load the review queue.');
      } finally {
        if (!cancelled) setQueueLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initialAccountId, reason]);

  useEffect(() => {
    if (!focusedId) return;
    let cancelled = false;
    (async () => {
      setFocusLoading(true);
      setFocusError(null);
      setActionMessage(null);
      try {
        const [t, l, d] = await Promise.all([
          apiGet<TxnDetail>(`/api/financial-data-hub/bank-transactions/${focusedId}`),
          apiGet<{ links: LinkRow[] }>(`/api/financial-data-hub/transaction-links?transaction_id=${focusedId}`),
          apiGet<{ candidates: DuplicateRow[] }>(`/api/financial-data-hub/duplicate-candidates?transaction_id=${focusedId}`),
        ]);
        if (cancelled) return;
        setTxn(t);
        setLinks(l.links);
        setDuplicates(d.candidates);
        setCorrectionValue(t.category_id ?? '');
      } catch (e) {
        if (!cancelled) setFocusError(e instanceof Error ? e.message : 'Could not load this transaction.');
      } finally {
        if (!cancelled) setFocusLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [focusedId]);

  function focusTransaction(id: string) {
    setFocusedId(id);
    router.replace(`/financial-data-hub/review?transaction=${id}&from=${fromParam}`, { scroll: false });
  }
  function backToQueue() {
    setFocusedId(null);
    setTxn(null);
    router.replace(`/financial-data-hub/review?from=${fromParam}`, { scroll: false });
    loadQueue();
  }

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setActionBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      await fn();
      setActionMessage(label);
      if (focusedId) await loadFocused(focusedId);
      await loadQueue();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'That action failed.');
    } finally {
      setActionBusy(false);
    }
  }

  // -------------------------------------------------------------------
  // Focused single-transaction view
  // -------------------------------------------------------------------
  if (focusedId) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => backToQueue()} className="text-sm font-semibold text-trust hover:underline">
          ← Back to review queue
        </button>
        {focusLoading && <ResourceLoadingSkeleton rows={4} />}
        {focusError && <ResourceErrorState message={focusError} onRetry={() => loadFocused(focusedId)} />}
        {txn && (
          <div className="space-y-4">
            <div className="rounded-compact border border-line bg-white p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-ink">{txn.description_clean ?? 'Untitled transaction'}</p>
                  <p className="text-xs text-muted">{txn.transaction_date} · {txn.economic_transaction_type}</p>
                </div>
                <p className="text-lg font-semibold tabular-nums text-ink">
                  {formatMoney(txn.amount_original, txn.currency_original as 'AUD' | 'INR')}
                </p>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted sm:grid-cols-3">
                <div><dt className="font-medium text-ink">Review status</dt><dd>{txn.review_status}</dd></div>
                <div><dt className="font-medium text-ink">Approval status</dt><dd>{txn.approval_status}</dd></div>
                <div><dt className="font-medium text-ink">Duplicate status</dt><dd>{txn.dedup_status}</dd></div>
              </dl>
            </div>

            {isDuplicateExcluded(txn.dedup_status) && (
              <p className="rounded-compact bg-trust/5 px-3 py-2 text-sm text-ink">
                This line was removed as a duplicate of another transaction. It is not counted and does not need approval.
              </p>
            )}

            {/* Approve */}
            {txn.approval_status !== 'approved' && !isDuplicateExcluded(txn.dedup_status) && (
              <div className="rounded-compact border border-line bg-white p-4">
                <h3 className="text-sm font-semibold text-ink">Approve this transaction</h3>
                <p className="mt-1 text-xs text-muted">Once approved, it counts toward your income/expense totals.</p>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => runAction('Transaction approved.', () => apiPost(`/api/financial-data-hub/bank-transactions/${txn.id}/approve`, {}))}
                  className="mt-3 rounded-compact bg-trust px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Approve
                </button>
              </div>
            )}

            {/* Correct classification. WP-08 (EXP-G12): an approved line is
                changed only after its statement is reopened (the server
                refuses with 409 either way). */}
            {txn.approval_status === 'approved' ? (
              <p className="rounded-compact border border-line bg-white p-4 text-sm text-muted">
                This transaction is approved. To change its category, type or split, reopen its statement first.
              </p>
            ) : (
            <div className="rounded-compact border border-line bg-white p-4">
              <h3 className="text-sm font-semibold text-ink">Correct classification</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label htmlFor="corr-field" className="text-xs font-medium text-muted">Field</label>
                <select
                  id="corr-field"
                  value={correctionField}
                  onChange={(e) => { setCorrectionField(e.target.value as typeof correctionField); setCorrectionValue(''); }}
                  className="rounded-compact border border-line bg-white px-2 py-1 text-sm"
                >
                  <option value="category_id">Category</option>
                  <option value="economic_transaction_type">Transaction type</option>
                </select>
                {correctionField === 'category_id' ? (
                  <select
                    aria-label="Corrected category"
                    value={correctionValue}
                    onChange={(e) => setCorrectionValue(e.target.value)}
                    className="rounded-compact border border-line bg-white px-2 py-1 text-sm"
                  >
                    <option value="">Select a category</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.label} ({TYPE_LABEL[c.economicType] ?? c.economicType})</option>
                    ))}
                  </select>
                ) : (
                  <select
                    aria-label="Corrected transaction type"
                    value={correctionValue}
                    onChange={(e) => setCorrectionValue(e.target.value)}
                    className="rounded-compact border border-line bg-white px-2 py-1 text-sm"
                  >
                    <option value="">Select a type</option>
                    {ECONOMIC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                <button
                  type="button"
                  disabled={actionBusy || !correctionValue}
                  onClick={() => runAction('Correction saved.', () => apiPost(`/api/financial-data-hub/bank-transactions/${txn.id}/correction`, {
                    field_name: correctionField,
                    corrected_value: correctionValue,
                  }))}
                  className="rounded-compact border border-trust px-3 py-1.5 text-sm font-semibold text-trust disabled:opacity-50"
                >
                  Save correction
                </button>
              </div>
            </div>
            )}

            {txn.approval_status !== 'approved' && !isDuplicateExcluded(txn.dedup_status) && (
              <SplitTransactionEditor
                transactionId={txn.id}
                amount={Number(txn.amount_original)}
                currency={txn.currency_original}
                categories={categories}
                disabled={actionBusy}
                onSave={(label, action) => { void runAction(label, action); }}
              />
            )}

            {/* Transfer / settlement / refund links */}
            {links.length > 0 && (
              <div className="rounded-compact border border-attention/30 bg-attention/5 p-4">
                <h3 className="text-sm font-semibold text-ink">Linked activity</h3>
                <ul className="mt-2 space-y-2">
                  {links.map((l) => (
                    <li key={l.id} className="flex items-center justify-between text-sm">
                      <span>{l.link_type.replace(/_/g, ' ')} — {l.status}</span>
                      {l.status === 'pending' && (
                        <span className="flex gap-2">
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => runAction('Link confirmed.', () => apiPost(`/api/financial-data-hub/transaction-links/${l.id}/review`, { decision: 'confirm' }))}
                            className="rounded-compact bg-trust px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => runAction('Link rejected.', () => apiPost(`/api/financial-data-hub/transaction-links/${l.id}/review`, { decision: 'reject' }))}
                            className="rounded-compact border border-line px-2 py-1 text-xs font-semibold text-ink disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Duplicate candidates */}
            {duplicates.length > 0 && (
              <div className="rounded-compact border border-attention/30 bg-attention/5 p-4">
                <h3 className="text-sm font-semibold text-ink">Possible duplicate</h3>
                <ul className="mt-2 space-y-2">
                  {duplicates.map((d) => (
                    <li key={d.id} className="flex items-center justify-between text-sm">
                      <span>{d.match_method.replace(/_/g, ' ')} — {d.status}</span>
                      {d.status === 'pending' && (
                        <span className="flex gap-2">
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => runAction('Marked as duplicate.', () => apiPost(`/api/financial-data-hub/bank-transactions/${txn.id}/duplicate-resolution`, { duplicate_candidate_id: d.id, resolution: 'removed_b' }))}
                            className="rounded-compact bg-trust px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                          >
                            Confirm duplicate
                          </button>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => runAction('Kept both transactions.', () => apiPost(`/api/financial-data-hub/bank-transactions/${txn.id}/duplicate-resolution`, { duplicate_candidate_id: d.id, resolution: 'kept_both' }))}
                            className="rounded-compact border border-line px-2 py-1 text-xs font-semibold text-ink disabled:opacity-50"
                          >
                            Keep both
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {actionMessage && <p role="status" className="text-sm text-positive">{actionMessage}</p>}
            {actionError && <p role="alert" className="text-sm text-risk">{actionError}</p>}
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------
  // General queue view
  // -------------------------------------------------------------------
  const awaiting = sections?.awaiting_approval ?? 0;
  const emptyTitle = awaiting > 0 ? `${awaiting} transaction${awaiting === 1 ? ' is' : 's are'} waiting for your approval` : 'Nothing is waiting';
  const emptyMessage = awaiting > 0
    ? 'None of them need a decision. Approve them by category from the statement list above. Until you approve them they do not count toward your Monthly Surplus.'
    : 'Every imported transaction has been approved.';

  return (
    <div className="space-y-4">
      <p role="status" aria-live="polite" className="sr-only">
        {sections ? `${sections.needs_attention} need a decision, ${awaiting} waiting for approval.` : ''}
      </p>

      {statements.length > 0 && (
        <section aria-labelledby="statements-heading" className="rounded-compact border border-trust/30 bg-trust/5 p-4">
          <h2 id="statements-heading" className="text-base font-semibold text-ink">Statements waiting for your approval</h2>
          <p className="mt-1 text-sm text-muted">
            The quickest way: review each statement by category, approve the totals, and only pick a category for the few
            transactions we could not recognise.
          </p>
          <ul className="mt-3 space-y-2">
            {statements.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-compact border border-line bg-white px-3 py-2">
                <span className="text-sm text-ink">
                  {s.period_start && s.period_end ? `Statement ${s.period_start} to ${s.period_end}` : (s.file_name ?? 'Imported statement')}
                  <span className="text-muted"> · {s.waiting} waiting</span>
                </span>
                <Link
                  href={`/financial-data-hub/review?statement=${s.id}&from=${fromParam}`}
                  className="rounded-compact bg-trust px-3 py-1.5 text-sm font-semibold text-white"
                >
                  Review by category
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sections && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label="Show transactions by reason">
          {FILTER_TILES.map((tile) => (
            <button
              key={tile.key}
              type="button"
              aria-pressed={(reason ?? 'needs_attention') === tile.reason}
              onClick={() => setReason(tile.reason)}
              className={`rounded-compact border bg-white p-3 text-left hover:border-trust ${(reason ?? 'needs_attention') === tile.reason ? 'border-trust' : 'border-line'}`}
            >
              <p className="text-lg font-semibold text-ink">{sections[tile.key]}</p>
              <p className="text-xs text-muted">{tile.label}</p>
            </button>
          ))}
        </div>
      )}
      {sections && sections.recurring_candidates > 0 && (
        <p className="text-xs text-muted">{sections.recurring_candidates} possible repeating payment{sections.recurring_candidates === 1 ? '' : 's'} found.</p>
      )}

      {reason && reason !== 'needs_attention' && (
        <p className="text-sm text-muted">
          Showing: <span className="font-medium text-ink">{REASON_LABEL[reason] ?? reason}</span>{' '}
          <button type="button" onClick={() => setReason(null)} className="ml-2 text-trust hover:underline">Show what needs a decision</button>
        </p>
      )}

      {queueLoading && <ResourceLoadingSkeleton rows={6} />}
      {queueError && <ResourceErrorState message={queueError} onRetry={() => { void loadQueue(); }} />}
      {!queueLoading && !queueError && items.length === 0 && (
        <ResourceEmptyState title={emptyTitle} message={emptyMessage} />
      )}
      {!queueLoading && !queueError && items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{REASON_LABEL[reason ?? 'needs_attention']}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="py-2 pr-2 font-medium">Date</th>
                <th scope="col" className="py-2 pr-2 font-medium">Description</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Amount</th>
                <th scope="col" className="py-2 pr-2 font-medium">Type</th>
                <th scope="col" className="py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-line/60">
                  <td className="py-2 pr-2 text-ink">{it.transaction_date}</td>
                  <td className="py-2 pr-2 text-ink">{it.description_clean ?? '—'}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-ink">
                    {formatMoneyCode(it.amount_original, it.currency_original)} {it.currency_original}
                  </td>
                  <td className="py-2 pr-2 text-muted">{TYPE_LABEL[it.economic_transaction_type] ?? it.economic_transaction_type}</td>
                  <td className="py-2">
                    <span className="flex flex-wrap gap-2">
                      {it.statement_upload_id && (
                        <Link
                          href={`/financial-data-hub/review?statement=${it.statement_upload_id}&from=${fromParam}`}
                          className="rounded-compact bg-trust px-2 py-1 text-xs font-semibold text-white"
                        >
                          Review statement by category
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() => focusTransaction(it.id)}
                        className="rounded-compact border border-trust px-2 py-1 text-xs font-semibold text-trust hover:bg-trust/5"
                      >
                        Open transaction
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
