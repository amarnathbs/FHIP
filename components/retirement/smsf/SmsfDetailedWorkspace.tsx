'use client';

import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { fetchJson, formatMoneySafe } from './format';
import { SmsfHoldingForm } from './SmsfHoldingForm';
import {
  HOLDING_CLASS_LABELS,
  HOLDING_TYPE_LABELS,
  type IncomeOption,
  type LiabilityOption,
  type SmsfFundRow,
  type SmsfHoldingRow,
} from './types';

interface PropertyLoanLink {
  id: string;
  liability_id: string;
  allocation_percent: number;
  liabilities: { id: string; liability_name: string; balance: number; currency_code: string } | null;
}

// Staged Detailed Holdings setup + reconciliation + mode-switch UI (spec
// s.10-14, s.19-31). Rendered from SmsfFundCard once the user chooses "Set
// up Detailed Holdings" — never itself flips the fund's active valuation
// source; the ONLY thing that does that is the explicit "Use Detailed
// Holdings" activation button below, which is a thin client for the
// smsf_switch_to_detailed() RPC's own hard $0-variance gate (migration
// 0084) — this component never computes or asserts reconciliation success
// itself, it only displays what the server already enforces.
export function SmsfDetailedWorkspace({ fund, onFundUpdated }: { fund: SmsfFundRow; onFundUpdated: (fund: SmsfFundRow) => void }) {
  const [holdings, setHoldings] = useState<SmsfHoldingRow[] | null>(null);
  const [links, setLinks] = useState<PropertyLoanLink[] | null>(null);
  const [liabilityOptions, setLiabilityOptions] = useState<LiabilityOption[]>([]);
  const [incomeOptions, setIncomeOptions] = useState<IncomeOption[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingHolding, setEditingHolding] = useState<SmsfHoldingRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SmsfHoldingRow | null>(null);
  const [selectedLiabilityId, setSelectedLiabilityId] = useState('');
  const [linking, setLinking] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [switchBackBalance, setSwitchBackBalance] = useState('');
  const [switchBackDate, setSwitchBackDate] = useState('');
  const [switchingBack, setSwitchingBack] = useState(false);
  const [switchBackError, setSwitchBackError] = useState<string | null>(null);
  const [confirmSwitchBack, setConfirmSwitchBack] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reloadAll() {
    const [h, l, liab, income, freshFund] = await Promise.all([
      fetchJson<SmsfHoldingRow[]>(`/api/smsf/${fund.id}/holdings`),
      fetchJson<PropertyLoanLink[]>(`/api/smsf/${fund.id}/property-loan`),
      fetchJson<LiabilityOption[]>('/api/liabilities'),
      fetchJson<IncomeOption[]>('/api/income'),
      fetchJson<SmsfFundRow>(`/api/smsf/${fund.id}`),
    ]);
    setHoldings(h);
    setLinks(l);
    setLiabilityOptions(liab);
    setIncomeOptions(income);
    onFundUpdated({ ...freshFund, retirement_accounts: fund.retirement_accounts });
  }

  useEffect(() => {
    (async () => {
      try {
        await reloadAll();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load Detailed Holdings');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fund.id]);

  const grossHoldingsTotal = useMemo(() => (holdings ?? []).reduce((s, h) => s + Number(h.value), 0), [holdings]);
  const linkedLiabilitiesTotal = useMemo(
    () => (links ?? []).reduce((s, l) => s + Number(l.liabilities?.balance ?? 0), 0),
    [links]
  );
  const detailedNet = fund.detailed_net_value ?? 0;
  const summaryValue = fund.summary_balance ?? 0;
  const difference = Math.round((detailedNet - summaryValue) * 100) / 100;
  const reconciled = difference === 0;

  async function handleArchive() {
    if (!archiveTarget) return;
    try {
      await fetchJson(`/api/smsf/${fund.id}/holdings/${archiveTarget.id}`, { method: 'DELETE' });
      setArchiveTarget(null);
      await reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove this holding');
      setArchiveTarget(null);
    }
  }

  async function linkLiability() {
    if (!selectedLiabilityId) return;
    setLinking(true);
    setError(null);
    try {
      await fetchJson(`/api/smsf/${fund.id}/property-loan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liability_id: selectedLiabilityId }),
      });
      setSelectedLiabilityId('');
      await reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link this liability');
    } finally {
      setLinking(false);
    }
  }

  async function unlinkLiability(linkId: string) {
    setLinking(true);
    setError(null);
    try {
      await fetchJson(`/api/smsf/${fund.id}/property-loan/${linkId}`, { method: 'DELETE' });
      await reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unlink this liability');
    } finally {
      setLinking(false);
    }
  }

  async function activateDetailed() {
    setActivating(true);
    setActivateError(null);
    try {
      await fetchJson(`/api/smsf/${fund.id}/switch-to-detailed`, { method: 'POST' });
      await reloadAll();
    } catch (e) {
      setActivateError(e instanceof Error ? e.message : 'Could not switch to Detailed Holdings');
    } finally {
      setActivating(false);
    }
  }

  async function confirmSwitchBackToSummary() {
    setSwitchingBack(true);
    setSwitchBackError(null);
    try {
      await fetchJson(`/api/smsf/${fund.id}/switch-to-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_summary_balance: Number(switchBackBalance), new_summary_balance_date: switchBackDate }),
      });
      setConfirmSwitchBack(false);
      await reloadAll();
    } catch (e) {
      setSwitchBackError(e instanceof Error ? e.message : 'Could not switch back to Summary Mode');
    } finally {
      setSwitchingBack(false);
    }
  }

  if (!holdings || !links) {
    return <p className="text-sm text-muted">Loading Detailed Holdings…</p>;
  }

  return (
    <div className="mt-3 space-y-4 border-t border-line pt-4">
      <div>
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            fund.mode === 'detailed' ? 'bg-progress/10 text-progress' : 'bg-attention/10 text-attention'
          }`}
        >
          {fund.mode === 'detailed' ? 'Detailed Mode — Active valuation' : 'Detailed Setup — Not yet active (Summary value remains active)'}
        </span>
      </div>

      {/* Saved-items list (spec s.12: Add/Edit-Entry-then-Saved-Items, not a spreadsheet). */}
      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">SMSF Holdings</h4>
          {!showAddForm && !editingHolding && (
            <button onClick={() => setShowAddForm(true)} className="text-sm font-medium text-trust hover:underline">
              + Add Holding
            </button>
          )}
        </div>

        {holdings.length === 0 && !showAddForm && <p className="mt-2 text-sm text-muted">No holdings entered yet.</p>}

        <ul className="mt-2 space-y-2">
          {holdings.map((h) =>
            editingHolding?.id === h.id ? (
              <li key={h.id}>
                <SmsfHoldingForm
                  fundId={fund.id}
                  currency={fund.currency_code}
                  incomeOptions={incomeOptions}
                  existing={h}
                  onSaved={() => {
                    setEditingHolding(null);
                    reloadAll();
                  }}
                  onCancel={() => setEditingHolding(null)}
                />
              </li>
            ) : (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-white p-3 text-sm">
                <div>
                  <p className="font-medium text-ink">{h.holding_name}</p>
                  <p className="text-xs text-muted">
                    {HOLDING_CLASS_LABELS[h.holding_class]} · {HOLDING_TYPE_LABELS[h.holding_type] ?? h.holding_type}
                    {h.country_code ? ` · ${h.country_code}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums text-ink">{formatMoneySafe(h.value, h.currency_code)}</span>
                  <button onClick={() => setEditingHolding(h)} className="text-xs text-trust hover:underline">
                    Edit
                  </button>
                  <button onClick={() => setArchiveTarget(h)} className="text-xs text-risk hover:underline">
                    Remove
                  </button>
                </div>
              </li>
            )
          )}
        </ul>

        {showAddForm && (
          <div className="mt-2">
            <SmsfHoldingForm
              fundId={fund.id}
              currency={fund.currency_code}
              incomeOptions={incomeOptions}
              onSaved={() => {
                setShowAddForm(false);
                reloadAll();
              }}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        )}
      </div>

      {/* Associated Debt (spec s.22-24) — fund-level, reusing the canonical Property<->Liability architecture (migration 0078). */}
      <div className="rounded-card border border-line bg-white p-3">
        <h4 className="text-sm font-semibold text-ink">Associated Debt</h4>
        {links.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No associated debt linked to this fund.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {links.map((l) => (
              <li key={l.id} className="flex items-center justify-between text-sm">
                <span>
                  {l.liabilities?.liability_name ?? 'Liability'} —{' '}
                  {formatMoneySafe(l.liabilities?.balance ?? 0, (l.liabilities?.currency_code as 'AUD' | 'INR') ?? 'AUD')}
                </span>
                <button onClick={() => unlinkLiability(l.id)} disabled={linking} className="text-xs text-risk hover:underline">
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={selectedLiabilityId}
            onChange={(e) => setSelectedLiabilityId(e.target.value)}
            className="rounded border border-line px-2 py-1 text-sm"
            aria-label="Link an existing liability as this fund's SMSF property loan"
          >
            <option value="">Link existing liability…</option>
            {liabilityOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.liability_name} ({formatMoneySafe(l.balance, l.currency_code)})
              </option>
            ))}
          </select>
          <button
            onClick={linkLiability}
            disabled={!selectedLiabilityId || linking}
            className="rounded border border-line px-3 py-1 text-xs text-ink hover:bg-gray-50 disabled:opacity-60"
          >
            Link
          </button>
          <a href="/liabilities" className="text-xs text-trust hover:underline">
            Add a new liability in Liabilities →
          </a>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          The property itself stays a gross asset value; any loan stays a canonical Liability. Linking here does not create a
          second loan — it only records the relationship.
        </p>
      </div>

      {/* Reconciliation UI (spec s.19-21, s.28-31) */}
      <div className="rounded-card border border-line bg-app p-3">
        <h4 className="text-sm font-semibold text-ink">Reconciliation</h4>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          <div>
            <p className="text-xs text-muted">Summary Value</p>
            <p className="font-semibold tabular-nums text-ink">{formatMoneySafe(summaryValue, fund.currency_code)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Detailed Gross Holdings</p>
            <p className="font-semibold tabular-nums text-ink">{formatMoneySafe(grossHoldingsTotal, fund.currency_code)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Linked SMSF Liabilities</p>
            <p className="font-semibold tabular-nums text-ink">{formatMoneySafe(linkedLiabilitiesTotal, fund.currency_code)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Detailed Net Value</p>
            <p className="font-semibold tabular-nums text-ink">{formatMoneySafe(detailedNet, fund.currency_code)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Difference</p>
            <p className={`font-semibold tabular-nums ${reconciled ? 'text-progress' : 'text-risk'}`}>
              {formatMoneySafe(difference, fund.currency_code)}
            </p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          The Summary value is already net of any SMSF debt — FHIP does not subtract a linked liability a second time while
          Summary Mode is active. Detailed Net Value = Gross Holdings − Linked SMSF Liabilities (converted to your reporting
          currency).
        </p>

        {fund.mode === 'summary' && (
          <div className="mt-3">
            {!reconciled && (
              <p className="mb-2 text-sm text-risk">
                Your detailed holdings do not yet reconcile to the SMSF summary value. Review the holdings before switching
                valuation methods.
              </p>
            )}
            <button
              onClick={activateDetailed}
              disabled={activating || holdings.length === 0}
              className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60"
            >
              {activating ? 'Switching…' : 'Use Detailed Holdings'}
            </button>
            {activateError && <p className="mt-2 text-sm text-risk">{activateError}</p>}
          </div>
        )}
      </div>

      {/* Switch back to Summary (spec s.32-33, migration 0087) */}
      {fund.mode === 'detailed' && (
        <div className="rounded-card border border-line bg-white p-3">
          <h4 className="text-sm font-semibold text-ink">Switch back to Summary Mode</h4>
          <p className="mt-1 text-xs text-muted">
            Your Detailed Holdings are kept as reference data — nothing is deleted. Enter a new Summary value and valuation
            date to make Summary Mode the active valuation again.
          </p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              type="number"
              step="0.01"
              min={0}
              placeholder="New Summary value"
              value={switchBackBalance}
              onChange={(e) => setSwitchBackBalance(e.target.value)}
              className="rounded border border-line px-2 py-1.5 text-sm"
              aria-label="New Summary value"
            />
            <input
              type="date"
              value={switchBackDate}
              onChange={(e) => setSwitchBackDate(e.target.value)}
              className="rounded border border-line px-2 py-1.5 text-sm"
              aria-label="New Summary valuation date"
            />
            <button
              onClick={() => setConfirmSwitchBack(true)}
              disabled={switchBackBalance === '' || !switchBackDate || switchingBack}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink hover:bg-gray-50 disabled:opacity-60"
            >
              Switch to Summary
            </button>
          </div>
          {switchBackError && <p className="mt-2 text-sm text-risk">{switchBackError}</p>}
        </div>
      )}

      <ConfirmDialog
        open={confirmSwitchBack}
        title="Switch back to Summary Mode?"
        message={`FHIP will use ${switchBackBalance || '—'} as your SMSF's active value in Net Worth from now on. Your Detailed Holdings stay saved as reference data.`}
        confirmLabel="Switch to Summary"
        destructive={false}
        onConfirm={confirmSwitchBackToSummary}
        onCancel={() => setConfirmSwitchBack(false)}
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        title="Remove this holding?"
        message={`"${archiveTarget?.holding_name ?? ''}" will be removed from your Detailed Holdings and Detailed totals will be recalculated.`}
        confirmLabel="Remove"
        onConfirm={handleArchive}
        onCancel={() => setArchiveTarget(null)}
      />

      {error && <p className="text-sm text-risk">{error}</p>}
    </div>
  );
}
