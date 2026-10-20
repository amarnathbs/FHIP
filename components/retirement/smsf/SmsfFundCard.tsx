'use client';

import { DateInput } from '@/components/ui/DateInput';
import { useState } from 'react';
import { fetchJson, formatMoneySafe, formatDateSafe } from './format';
import { SmsfMembers } from './SmsfMembers';
import { SmsfDetailedWorkspace } from './SmsfDetailedWorkspace';
import { SmsfModeSwitch } from './SmsfModeSwitch';
import { SmsfReportsPanel } from './SmsfReportsPanel';
import { userVisibleFundNotes } from '@/lib/engines/smsf/smsfNotes';
import type { SmsfFundRow } from './types';

// One SMSF fund's card. The fund is recorded in exactly ONE of two ways (PO decision 17-10-2026): ITEMISED (assets and liabilities, the net
// is worked out for you and cannot be typed) or a NET VALUE ONLY (one typed value, no assets or liabilities). The mode chooser below changes
// it safely: preview first, history kept, undo available. The database enforces the rule (migration 0290).
export function SmsfFundCard({ fund: initialFund, onFundChanged }: { fund: SmsfFundRow; onFundChanged: () => void }) {
  const [fund, setFund] = useState(initialFund);
  const [editingSummary, setEditingSummary] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fundNameDraft, setFundNameDraft] = useState(fund.fund_name);
  const [balanceDraft, setBalanceDraft] = useState(fund.summary_balance != null ? String(fund.summary_balance) : '');
  const [dateDraft, setDateDraft] = useState(fund.summary_balance_date ?? '');
  const [notesDraft, setNotesDraft] = useState(userVisibleFundNotes(fund.notes) ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const badge =
    fund.mode === 'detailed'
      ? { text: 'Itemised: assets and liabilities, net worked out', cls: 'bg-progress/10 text-progress' }
      : { text: 'Net value only', cls: 'bg-trust/10 text-trust' };

  async function afterModeChange() {
    try {
      const fresh = await fetchJson<SmsfFundRow>(`/api/smsf/${fund.id}`);
      setFund((f) => ({ ...f, ...fresh, retirement_accounts: f.retirement_accounts }));
      setBalanceDraft(fresh.summary_balance != null ? String(fresh.summary_balance) : '');
    } catch {
      /* the parent reload below refreshes the list anyway */
    }
    setRefreshKey((k) => k + 1);
    onFundChanged();
  }

  async function saveSummary() {
    setSaving(true);
    setError(null);
    try {
      const updated = await fetchJson<SmsfFundRow>(`/api/smsf/${fund.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fund_name: fundNameDraft,
          summary_balance: Number(balanceDraft),
          summary_balance_date: dateDraft || null,
          notes: notesDraft || null,
        }),
      });
      setFund((f) => ({ ...f, ...updated }));
      setEditingSummary(false);
      onFundChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save changes');
    } finally {
      setSaving(false);
    }
  }

  function handleFundUpdated(next: SmsfFundRow) {
    setFund(next);
    onFundChanged();
  }

  return (
    <div className="rounded-card border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-ink">SMSF — {fund.fund_name}</h3>
          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.text}</span>
        </div>
      </div>

      <div className="mt-3">
        <SmsfMembers fundId={fund.id} currency={fund.currency_code} />
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <SmsfModeSwitch fund={fund} refreshKey={refreshKey} onChanged={afterModeChange} />
      </div>

      {fund.mode === 'summary' && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Net value</h4>
            {!editingSummary && (
              <button onClick={() => setEditingSummary(true)} className="text-xs text-trust hover:underline">
                Edit
              </button>
            )}
          </div>
          {editingSummary ? (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor={`fund-name-${fund.id}`} className="block text-xs text-muted">Fund Name</label>
                <input id={`fund-name-${fund.id}`} type="text" value={fundNameDraft} onChange={(e) => setFundNameDraft(e.target.value)} className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label htmlFor={`fund-balance-${fund.id}`} className="block text-xs text-muted">Net value (assets minus debts)</label>
                <input id={`fund-balance-${fund.id}`} type="number" inputMode="decimal" step="0.01" min={0} value={balanceDraft} onChange={(e) => setBalanceDraft(e.target.value)} className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label htmlFor={`fund-date-${fund.id}`} className="block text-xs text-muted">Valuation Date</label>
                <DateInput id={`fund-date-${fund.id}`} value={dateDraft} onChange={(e) => setDateDraft(e.target.value)} className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label htmlFor={`fund-notes-${fund.id}`} className="block text-xs text-muted">Notes</label>
                <input id={`fund-notes-${fund.id}`} type="text" value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm" />
              </div>
              {error && <p role="alert" className="text-sm text-risk sm:col-span-2">{error}</p>}
              <div className="flex items-center gap-3 sm:col-span-2">
                <button onClick={saveSummary} disabled={saving || balanceDraft === ''} className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setEditingSummary(false)} className="text-sm text-muted hover:underline">Cancel</button>
              </div>
            </div>
          ) : (
            <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Net value</dt>
                <dd className="font-semibold tabular-nums text-ink">{formatMoneySafe(fund.summary_balance, fund.currency_code)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Valuation Date</dt>
                <dd className="text-ink">{formatDateSafe(fund.summary_balance_date)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Currency</dt>
                <dd className="text-ink">{fund.currency_code}</dd>
              </div>
              {userVisibleFundNotes(fund.notes) && (
                <div className="col-span-2 sm:col-span-4">
                  <dt className="text-xs text-muted">Notes</dt>
                  <dd className="text-ink">{userVisibleFundNotes(fund.notes)}</dd>
                </div>
              )}
            </dl>
          )}
          <p className="mt-2 text-[11px] text-muted">
            This fund is recorded as a net value only, so assets and liabilities cannot be added to it. Choose &quot;Itemised assets and liabilities&quot; above to enter them.
          </p>
        </div>
      )}

      {fund.mode === 'detailed' && (
        <div className="mt-3 border-t border-line pt-3">
          <SmsfDetailedWorkspace key={refreshKey} fund={fund} onFundUpdated={handleFundUpdated} />
        </div>
      )}

      <SmsfReportsPanel fund={fund} />
    </div>
  );
}
