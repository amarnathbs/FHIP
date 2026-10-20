'use client';

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { fetchJson, formatMoneySafe } from './format';
import { SmsfHoldingForm } from './SmsfHoldingForm';
import { SmsfLiabilityForm } from './SmsfLiabilityForm';
import { SmsfNetPosition } from './SmsfNetPosition';
import {
  HOLDING_CLASS_LABELS,
  HOLDING_TYPE_LABELS,
  LIABILITY_TYPE_LABELS,
  type IncomeOption,
  type SmsfFundRow,
  type SmsfHoldingRow,
  type SmsfLiabilityRow,
  type SmsfSwitchResult,
} from './types';

interface LinkedLoan {
  id: string;
  liability_id: string;
  liabilities: { id: string; liability_name: string; balance: number; currency_code: string } | null;
}

// The ITEMISED recording of an SMSF fund (PO decision 17-10-2026): the fund's assets (holdings) and its own liabilities are entered
// here, and the net position is DERIVED and shown read-only. There is no input for the net on this screen. A leftover typed net value
// (from before this rule) and a personal loan still linked to the fund (the earlier way) are shown with a safe action to retire or
// move them, so nothing is counted twice and nothing is changed silently.
export function SmsfDetailedWorkspace({ fund, onFundUpdated }: { fund: SmsfFundRow; onFundUpdated: (fund: SmsfFundRow) => void }) {
  const [holdings, setHoldings] = useState<SmsfHoldingRow[] | null>(null);
  const [liabilities, setLiabilities] = useState<SmsfLiabilityRow[] | null>(null);
  const [links, setLinks] = useState<LinkedLoan[] | null>(null);
  const [incomeOptions, setIncomeOptions] = useState<IncomeOption[]>([]);
  const [showAddHolding, setShowAddHolding] = useState(false);
  const [editingHolding, setEditingHolding] = useState<SmsfHoldingRow | null>(null);
  const [archiveHolding, setArchiveHolding] = useState<SmsfHoldingRow | null>(null);
  const [showAddLiability, setShowAddLiability] = useState(false);
  const [editingLiability, setEditingLiability] = useState<SmsfLiabilityRow | null>(null);
  const [archiveLiability, setArchiveLiability] = useState<SmsfLiabilityRow | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ link: LinkedLoan; preview: SmsfSwitchResult } | null>(null);
  const [retirePreview, setRetirePreview] = useState<{ typed_net: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reloadAll() {
    const [h, l, links2, income, freshFund] = await Promise.all([
      fetchJson<SmsfHoldingRow[]>(`/api/smsf/${fund.id}/holdings`),
      fetchJson<SmsfLiabilityRow[]>(`/api/smsf/${fund.id}/liabilities`),
      fetchJson<LinkedLoan[]>(`/api/smsf/${fund.id}/property-loan`),
      fetchJson<IncomeOption[]>('/api/income'),
      fetchJson<SmsfFundRow>(`/api/smsf/${fund.id}`),
    ]);
    setHoldings(h);
    setLiabilities(l);
    setLinks(links2);
    setIncomeOptions(income);
    onFundUpdated({ ...freshFund, retirement_accounts: fund.retirement_accounts });
  }

  useEffect(() => {
    (async () => {
      try {
        await reloadAll();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the fund');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fund.id]);

  async function call(url: string, init: RequestInit, fallback: string) {
    setError(null);
    try {
      await fetchJson(url, init);
      await reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    }
  }

  async function startMove(link: LinkedLoan) {
    setError(null);
    try {
      const preview = await fetchJson<SmsfSwitchResult>(`/api/smsf/${fund.id}/move-loan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liability_id: link.liability_id, confirm: false }) });
      setMoveTarget({ link, preview });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check this move');
    }
  }
  async function startRetire() {
    setError(null);
    try {
      const preview = await fetchJson<{ typed_net: number }>(`/api/smsf/${fund.id}/retire-typed-net`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: false }) });
      setRetirePreview(preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check this');
    }
  }

  if (!holdings || !liabilities || !links) {
    return error ? <p role="alert" className="text-sm text-risk">{error}</p> : <p className="text-sm text-muted">Loading the fund&apos;s assets and liabilities…</p>;
  }

  const sameCurrency = [...holdings, ...liabilities].every((x) => x.currency_code === fund.currency_code) && links.every((l) => (l.liabilities?.currency_code ?? fund.currency_code) === fund.currency_code);
  const propertyHoldings = holdings.filter((h) => h.holding_class === 'property');
  const assetTotal = holdings.reduce((s, h) => s + Number(h.value), 0);
  const liabilityTotal = liabilities.reduce((s, l) => s + Number(l.balance), 0) + links.reduce((s, l) => s + Number(l.liabilities?.balance ?? 0), 0);

  return (
    <div className="space-y-4">
      {fund.summary_balance !== null && (
        <div role="note" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-ink">
          <p className="font-medium">A net value typed earlier is still stored on this fund</p>
          <p className="mt-1">
            This fund is itemised, so only its assets and liabilities are counted; the typed value of {formatMoneySafe(fund.summary_balance, fund.currency_code)} is not. Retire it so the fund has one record only. It stays in your history.
          </p>
          <button type="button" onClick={startRetire} className="mt-2 rounded border border-line bg-white px-3 py-1 text-xs text-ink hover:bg-gray-50">Retire the typed value</button>
        </div>
      )}

      <SmsfNetPosition
        assets={sameCurrency ? assetTotal : Number(fund.detailed_net_value ?? 0) + liabilityTotal}
        liabilities={sameCurrency ? liabilityTotal : liabilityTotal}
        currency={fund.currency_code}
        note={sameCurrency ? undefined : 'Some lines are in another currency, so the totals above are approximate; the net is worked out by FHIP at your reporting rate.'}
      />

      {/* Assets */}
      <section aria-label="Assets of the fund">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Assets</h4>
          {!showAddHolding && !editingHolding && (
            <button onClick={() => setShowAddHolding(true)} className="text-sm font-medium text-trust hover:underline">+ Add asset</button>
          )}
        </div>
        {holdings.length === 0 && !showAddHolding && <p className="mt-2 text-sm text-muted">No assets entered yet.</p>}
        <ul className="mt-2 space-y-2">
          {holdings.map((h) =>
            editingHolding?.id === h.id ? (
              <li key={h.id}>
                <SmsfHoldingForm fundId={fund.id} currency={fund.currency_code} incomeOptions={incomeOptions} existing={h} onSaved={() => { setEditingHolding(null); void reloadAll(); }} onCancel={() => setEditingHolding(null)} />
              </li>
            ) : (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-white p-3 text-sm">
                <div>
                  <p className="font-medium text-ink">{h.holding_name}</p>
                  <p className="text-xs text-muted">{HOLDING_CLASS_LABELS[h.holding_class]} · {HOLDING_TYPE_LABELS[h.holding_type] ?? h.holding_type}{h.country_code ? ` · ${h.country_code}` : ''}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums text-ink">{formatMoneySafe(h.value, h.currency_code)}</span>
                  <button onClick={() => setEditingHolding(h)} className="text-xs text-trust hover:underline">Edit</button>
                  <button onClick={() => setArchiveHolding(h)} className="text-xs text-risk hover:underline">Remove</button>
                </div>
              </li>
            ),
          )}
        </ul>
        {showAddHolding && (
          <div className="mt-2">
            <SmsfHoldingForm fundId={fund.id} currency={fund.currency_code} incomeOptions={incomeOptions} onSaved={() => { setShowAddHolding(false); void reloadAll(); }} onCancel={() => setShowAddHolding(false)} />
          </div>
        )}
      </section>

      {/* Liabilities */}
      <section aria-label="Liabilities of the fund">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Liabilities</h4>
          {!showAddLiability && !editingLiability && (
            <button onClick={() => setShowAddLiability(true)} className="text-sm font-medium text-trust hover:underline">+ Add liability</button>
          )}
        </div>
        {liabilities.length === 0 && links.length === 0 && !showAddLiability && <p className="mt-2 text-sm text-muted">No liabilities entered. If the fund has a loan, add it here so the net position is right.</p>}
        <ul className="mt-2 space-y-2">
          {liabilities.map((l) =>
            editingLiability?.id === l.id ? (
              <li key={l.id}>
                <SmsfLiabilityForm fundId={fund.id} currency={fund.currency_code} propertyHoldings={propertyHoldings} existing={l} onSaved={() => { setEditingLiability(null); void reloadAll(); }} onCancel={() => setEditingLiability(null)} />
              </li>
            ) : (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-white p-3 text-sm">
                <div>
                  <p className="font-medium text-ink">{l.liability_name}</p>
                  <p className="text-xs text-muted">
                    {LIABILITY_TYPE_LABELS[l.liability_type]}
                    {l.lender ? ` · ${l.lender}` : ''}
                    {l.interest_rate != null ? ` · ${l.interest_rate}%` : ''}
                    {l.monthly_repayment != null ? ` · ${formatMoneySafe(l.monthly_repayment, l.currency_code)} a month` : ''}
                    {l.smsf_holding_id && holdings.find((h) => h.id === l.smsf_holding_id) ? ` · funds ${holdings.find((h) => h.id === l.smsf_holding_id)!.holding_name}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums text-ink">{formatMoneySafe(l.balance, l.currency_code)}</span>
                  <button onClick={() => setEditingLiability(l)} className="text-xs text-trust hover:underline">Edit</button>
                  <button onClick={() => setArchiveLiability(l)} className="text-xs text-risk hover:underline">Remove</button>
                </div>
              </li>
            ),
          )}
          {links.map((link) => (
            <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-amber-300 bg-amber-50 p-3 text-sm">
              <div>
                <p className="font-medium text-ink">{link.liabilities?.liability_name ?? 'Liability'} (linked from your personal liabilities)</p>
                <p className="text-xs text-muted">Recorded the earlier way. Move it into the fund so the debt lives in one place; the fund&apos;s net does not change.</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold tabular-nums text-ink">{formatMoneySafe(link.liabilities?.balance ?? 0, (link.liabilities?.currency_code as 'AUD' | 'INR') ?? 'AUD')}</span>
                <button onClick={() => startMove(link)} className="rounded border border-line bg-white px-3 py-1 text-xs text-ink hover:bg-gray-50">Move into the fund</button>
              </div>
            </li>
          ))}
        </ul>
        {showAddLiability && (
          <div className="mt-2">
            <SmsfLiabilityForm fundId={fund.id} currency={fund.currency_code} propertyHoldings={propertyHoldings} onSaved={() => { setShowAddLiability(false); void reloadAll(); }} onCancel={() => setShowAddLiability(false)} />
          </div>
        )}
      </section>

      {error && <p role="alert" className="text-sm text-risk">{error}</p>}

      <ConfirmDialog
        open={archiveHolding !== null}
        title="Remove this asset?"
        message={`"${archiveHolding?.holding_name ?? ''}" will be removed from the fund and the net position is worked out again.`}
        confirmLabel="Remove"
        onConfirm={async () => {
          const target = archiveHolding;
          setArchiveHolding(null);
          if (target) await call(`/api/smsf/${fund.id}/holdings/${target.id}`, { method: 'DELETE' }, 'Could not remove this asset');
        }}
        onCancel={() => setArchiveHolding(null)}
      />
      <ConfirmDialog
        open={archiveLiability !== null}
        title="Remove this liability?"
        message={`"${archiveLiability?.liability_name ?? ''}" will be removed from the fund and the net position is worked out again.`}
        confirmLabel="Remove"
        onConfirm={async () => {
          const target = archiveLiability;
          setArchiveLiability(null);
          if (target) await call(`/api/smsf/${fund.id}/liabilities/${target.id}`, { method: 'DELETE' }, 'Could not remove this liability');
        }}
        onCancel={() => setArchiveLiability(null)}
      />
      <ConfirmDialog
        open={moveTarget !== null}
        title="Move this loan into the fund?"
        message={`"${moveTarget?.link.liabilities?.liability_name ?? ''}" becomes a liability of the fund and leaves your personal liabilities. The fund's net stays ${formatMoneySafe(moveTarget?.preview.net_after ?? null, fund.currency_code)}; the loan is counted once. It is kept in your history.`}
        confirmLabel="Move into the fund"
        destructive={false}
        onConfirm={async () => {
          const target = moveTarget;
          setMoveTarget(null);
          if (target) await call(`/api/smsf/${fund.id}/move-loan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liability_id: target.link.liability_id, confirm: true }) }, 'Could not move this loan');
        }}
        onCancel={() => setMoveTarget(null)}
      />
      <ConfirmDialog
        open={retirePreview !== null}
        title="Retire the typed net value?"
        message={`The value ${formatMoneySafe(retirePreview?.typed_net ?? null, fund.currency_code)} is removed from this fund and kept in your history. The fund's net does not change, because only its assets and liabilities were counted.`}
        confirmLabel="Retire it"
        destructive={false}
        onConfirm={async () => {
          setRetirePreview(null);
          await call(`/api/smsf/${fund.id}/retire-typed-net`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }, 'Could not retire the typed value');
        }}
        onCancel={() => setRetirePreview(null)}
      />
    </div>
  );
}
