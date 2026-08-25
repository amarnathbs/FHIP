'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMoney } from '@/lib/engines/money';
import { ResourceEmptyState, ResourceErrorState, ResourceLoadingSkeleton } from '@/components/resources/admin/ResourceStates';

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

interface QueueSections {
  needs_attention: number;
  transfers: number;
  possible_duplicates: number;
  uncategorised: number;
  low_confidence: number;
  recurring_candidates: number;
  ready_to_approve: number;
}

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
  needs_attention: 'Needs attention',
  transfers: 'Possible transfers',
  duplicates: 'Possible duplicates',
  uncategorised: 'Uncategorised',
  recurring: 'Recurring candidates',
};

export function ReviewWorkspace({
  initialTransactionId,
  initialStatementId,
  initialReason,
  initialAccountId,
  categories,
}: {
  initialTransactionId: string | null;
  initialStatementId: string | null;
  initialReason: string | null;
  initialAccountId: string | null;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [sections, setSections] = useState<QueueSections | null>(null);
  const [reason, setReason] = useState<string | null>(initialReason);

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

  const [statementId] = useState<string | null>(initialStatementId);
  const [statementSummary, setStatementSummary] = useState<Record<string, unknown> | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const qs = initialAccountId ? `?account_id=${encodeURIComponent(initialAccountId)}` : '';
      const data = await apiGet<{ items: QueueItem[]; sections: QueueSections }>(`/api/financial-data-hub/review-queue${qs}`);
      setItems(data.items);
      setSections(data.sections);
    } catch (e) {
      setQueueError(e instanceof Error ? e.message : 'Could not load the review queue.');
    } finally {
      setQueueLoading(false);
    }
  }, [initialAccountId]);

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

  const loadStatement = useCallback(async (id: string) => {
    setStatementLoading(true);
    setStatementError(null);
    try {
      const data = await apiGet<Record<string, unknown>>(`/api/financial-data-hub/documents/${id}/review-summary`);
      setStatementSummary(data);
    } catch (e) {
      setStatementError(e instanceof Error ? e.message : 'Could not load this statement.');
    } finally {
      setStatementLoading(false);
    }
  }, []);

  // Each mount/param-change effect below re-does its fetch inline (rather
  // than calling the loadX() function by reference) with a `cancelled`
  // guard before every setState — the accepted pattern this codebase uses
  // for the react-hooks/set-state-in-effect rule (see
  // components/investment-intelligence/InvestmentIntelligenceClient.tsx).
  // loadQueue/loadFocused/loadStatement themselves are still reused
  // directly by the retry buttons and post-action refresh below, where
  // calling them is not subject to this rule.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setQueueLoading(true);
      setQueueError(null);
      try {
        const qs = initialAccountId ? `?account_id=${encodeURIComponent(initialAccountId)}` : '';
        const data = await apiGet<{ items: QueueItem[]; sections: QueueSections }>(`/api/financial-data-hub/review-queue${qs}`);
        if (cancelled) return;
        setItems(data.items);
        setSections(data.sections);
      } catch (e) {
        if (!cancelled) setQueueError(e instanceof Error ? e.message : 'Could not load the review queue.');
      } finally {
        if (!cancelled) setQueueLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initialAccountId]);

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

  useEffect(() => {
    if (!statementId) return;
    let cancelled = false;
    (async () => {
      setStatementLoading(true);
      setStatementError(null);
      try {
        const data = await apiGet<Record<string, unknown>>(`/api/financial-data-hub/documents/${statementId}/review-summary`);
        if (cancelled) return;
        setStatementSummary(data);
      } catch (e) {
        if (!cancelled) setStatementError(e instanceof Error ? e.message : 'Could not load this statement.');
      } finally {
        if (!cancelled) setStatementLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [statementId]);

  function focusTransaction(id: string) {
    setFocusedId(id);
    router.replace(`/financial-data-hub/review?transaction=${id}`, { scroll: false });
  }
  function backToQueue() {
    setFocusedId(null);
    setTxn(null);
    router.replace('/financial-data-hub/review', { scroll: false });
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

  const filteredItems = items.filter((it) => {
    if (!reason || reason === 'needs_attention') return true;
    if (reason === 'uncategorised') return it.economic_transaction_type === 'unknown';
    if (reason === 'transfers') return it.economic_transaction_type === 'transfer';
    return true;
  });

  // -------------------------------------------------------------------
  // Statement-focused view
  // -------------------------------------------------------------------
  if (statementId) {
    return (
      <div className="space-y-4">
        {statementLoading && <ResourceLoadingSkeleton rows={3} />}
        {statementError && <ResourceErrorState message={statementError} onRetry={() => loadStatement(statementId)} />}
        {statementSummary && (
          <div className="rounded-compact border border-line bg-white p-4">
            <h2 className="text-sm font-semibold text-ink">Statement review</h2>
            <pre className="mt-2 overflow-x-auto text-xs text-muted">{JSON.stringify(statementSummary, null, 2)}</pre>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => runAction('Statement approved.', () => apiPost(`/api/financial-data-hub/documents/${statementId}/approve`, {}))}
              className="mt-3 rounded-compact bg-trust px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Approve statement
            </button>
            {actionMessage && <p className="mt-2 text-sm text-positive">{actionMessage}</p>}
            {actionError && <p className="mt-2 text-sm text-risk">{actionError}</p>}
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------
  // Focused single-transaction view
  // -------------------------------------------------------------------
  if (focusedId) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={backToQueue} className="text-sm font-semibold text-trust hover:underline">
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

            {/* Approve */}
            {txn.approval_status !== 'approved' && (
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

            {/* Correct classification */}
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
                      <option key={c.id} value={c.id}>{c.label} ({c.economicType})</option>
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
  return (
    <div className="space-y-4">
      {sections && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" role="list" aria-label="Review categories">
          {(['needs_attention', 'transfers', 'possible_duplicates', 'uncategorised', 'low_confidence', 'recurring_candidates'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="listitem"
              onClick={() => setReason(key === 'possible_duplicates' ? 'duplicates' : key === 'recurring_candidates' ? 'recurring' : key)}
              className="rounded-compact border border-line bg-white p-3 text-left hover:border-trust"
            >
              <p className="text-lg font-semibold text-ink">{sections[key]}</p>
              <p className="text-xs text-muted">{key.replace(/_/g, ' ')}</p>
            </button>
          ))}
        </div>
      )}

      {reason && (
        <p className="text-sm text-muted">
          Filtered to: <span className="font-medium text-ink">{REASON_LABEL[reason] ?? reason}</span>{' '}
          <button type="button" onClick={() => setReason(null)} className="ml-2 text-trust hover:underline">Clear filter</button>
        </p>
      )}

      {queueLoading && <ResourceLoadingSkeleton rows={6} />}
      {queueError && <ResourceErrorState message={queueError} onRetry={loadQueue} />}
      {!queueLoading && !queueError && filteredItems.length === 0 && (
        <ResourceEmptyState title="Nothing to review" message="Every transaction in scope has already been reviewed." />
      )}
      {!queueLoading && !queueError && filteredItems.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Transactions awaiting review</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="py-2 pr-2 font-medium">Date</th>
                <th scope="col" className="py-2 pr-2 font-medium">Description</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Amount</th>
                <th scope="col" className="py-2 pr-2 font-medium">Type</th>
                <th scope="col" className="py-2 pr-2 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((it) => (
                <tr key={it.id} className="border-b border-line/60">
                  <td className="py-2 pr-2 text-ink">{it.transaction_date}</td>
                  <td className="py-2 pr-2 text-ink">{it.description_clean ?? '—'}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-ink">
                    {formatMoney(it.amount_original, it.currency_original as 'AUD' | 'INR')}
                  </td>
                  <td className="py-2 pr-2 text-muted">{it.economic_transaction_type}</td>
                  <td className="py-2 pr-2 text-muted">{it.review_status}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => focusTransaction(it.id)}
                      className="rounded-compact border border-trust px-2 py-1 text-xs font-semibold text-trust hover:bg-trust/5"
                    >
                      Review transaction
                    </button>
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
