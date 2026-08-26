'use client';

import { useState } from 'react';
import { fetchJson, formatMoneySafe, formatDateSafe } from './format';
import { SmsfMembers } from './SmsfMembers';
import { SmsfDetailedWorkspace } from './SmsfDetailedWorkspace';
import type { SmsfFundRow } from './types';

// One SMSF fund's card (spec s.4-9, s.32-33). Summary Mode is rendered as a
// complete, valid, permanent state here — nothing about this card implies
// Detailed Holdings are required or that Summary is "incomplete" (spec s.9:
// "not an incomplete state").
export function SmsfFundCard({ fund: initialFund, onFundChanged }: { fund: SmsfFundRow; onFundChanged: () => void }) {
  const [fund, setFund] = useState(initialFund);
  const [editingSummary, setEditingSummary] = useState(false);
  const [showDetailedSetup, setShowDetailedSetup] = useState(fund.mode === 'detailed');
  const [fundNameDraft, setFundNameDraft] = useState(fund.fund_name);
  const [balanceDraft, setBalanceDraft] = useState(fund.summary_balance != null ? String(fund.summary_balance) : '');
  const [dateDraft, setDateDraft] = useState(fund.summary_balance_date ?? '');
  const [notesDraft, setNotesDraft] = useState(fund.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const badge =
    fund.mode === 'detailed'
      ? { text: 'Detailed Mode — Active valuation', cls: 'bg-progress/10 text-progress' }
      : showDetailedSetup
        ? { text: 'Detailed Setup — Not yet active', cls: 'bg-attention/10 text-attention' }
        : { text: 'Summary Mode — Active valuation', cls: 'bg-trust/10 text-trust' };

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

      {/* Summary Mode figures + inline edit (spec s.8-9). Always shown and
          editable regardless of current mode — spec s.19-21: even while
          Detailed is active, Summary remains a recorded figure users can
          revisit when they switch back. */}
      <div className="mt-3 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Summary</h4>
          {!editingSummary && fund.mode === 'summary' && (
            <button onClick={() => setEditingSummary(true)} className="text-xs text-trust hover:underline">
              Edit
            </button>
          )}
        </div>

        {editingSummary ? (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor={`fund-name-${fund.id}`} className="block text-xs text-muted">
                Fund Name
              </label>
              <input
                id={`fund-name-${fund.id}`}
                type="text"
                value={fundNameDraft}
                onChange={(e) => setFundNameDraft(e.target.value)}
                className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor={`fund-balance-${fund.id}`} className="block text-xs text-muted">
                Current SMSF Value
              </label>
              <input
                id={`fund-balance-${fund.id}`}
                type="number"
                step="0.01"
                min={0}
                value={balanceDraft}
                onChange={(e) => setBalanceDraft(e.target.value)}
                className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor={`fund-date-${fund.id}`} className="block text-xs text-muted">
                Valuation Date
              </label>
              <input
                id={`fund-date-${fund.id}`}
                type="date"
                value={dateDraft}
                onChange={(e) => setDateDraft(e.target.value)}
                className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor={`fund-notes-${fund.id}`} className="block text-xs text-muted">
                Notes
              </label>
              <input
                id={`fund-notes-${fund.id}`}
                type="text"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
              />
            </div>
            {error && <p className="text-sm text-risk sm:col-span-2">{error}</p>}
            <div className="flex items-center gap-3 sm:col-span-2">
              <button
                onClick={saveSummary}
                disabled={saving || balanceDraft === ''}
                className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditingSummary(false)} className="text-sm text-muted hover:underline">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Current SMSF Value</dt>
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
            {fund.notes && (
              <div className="col-span-2 sm:col-span-4">
                <dt className="text-xs text-muted">Notes</dt>
                <dd className="text-ink">{fund.notes}</dd>
              </div>
            )}
          </dl>
        )}
        <p className="mt-2 text-[11px] text-muted">
          FHIP is currently using the SMSF {fund.mode === 'detailed' ? 'detailed' : 'summary'} value in your retirement and Net
          Worth calculations.
        </p>
      </div>

      {/* Staged Detailed Holdings entry point (spec s.10-11). */}
      <div className="mt-3 border-t border-line pt-3">
        {!showDetailedSetup ? (
          <button onClick={() => setShowDetailedSetup(true)} className="text-sm font-medium text-trust hover:underline">
            Set up Detailed Holdings
          </button>
        ) : (
          <SmsfDetailedWorkspace fund={fund} onFundUpdated={handleFundUpdated} />
        )}
      </div>
    </div>
  );
}
