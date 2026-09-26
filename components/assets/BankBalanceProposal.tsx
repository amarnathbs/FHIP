'use client';

/**
 * WP-15 (b) -- "Add your bank balance to Assets" (PO D-04).
 *
 * One row per bank account with an approved statement closing balance. The
 * balance reaches Net Worth only when the user adds it here: as a new cash
 * asset, or as an update to the asset that account already feeds -- or, when
 * the user says "this is my existing <asset>", as an update to that one, so
 * the same money is never counted twice. Until then it is evidence only.
 */
import { useEffect, useState } from 'react';
import { formatMoneyWhole } from '@/lib/engines/money';
import type { BankBalanceItemDto, BankBalancesResponse } from '@/lib/import-bridge/populationProposalDto';

const money = (v: number, c: string) => formatMoneyWhole(v, c === 'INR' ? 'INR' : 'AUD');

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch('/api/assets/bank-balances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

export function BankBalanceProposal({ onApplied, disabled = false }: { onApplied: () => void; disabled?: boolean }) {
  const [data, setData] = useState<BankBalancesResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/assets/bank-balances')
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setData(j.data as BankBalancesResponse); })
      .catch(() => { if (!cancelled) setData({ status: 'unavailable', reason: 'request_failed' }); });
    return () => { cancelled = true; };
  }, []);

  if (!data || data.status !== 'ok' || data.items.length === 0) return null;

  async function act(item: BankBalanceItemDto, kind: 'apply' | 'keep') {
    setBusy(item.accountId);
    setMessage(null);
    try {
      const generated = await post<{ status: string; item?: BankBalanceItemDto }>({ action: 'generate', accountId: item.accountId, targetAssetId: target[item.accountId] || null });
      const proposal = generated.item;
      if (generated.status !== 'ok' || !proposal?.proposalId || !proposal.recommended) throw new Error(proposal?.stateLabel ?? 'This balance cannot be added right now.');
      const decision = kind === 'keep' ? 'keep_existing' : proposal.recommended === 'add_new' ? 'add_new' : 'update_existing';
      await post({ action: 'apply', proposalId: proposal.proposalId, decision });
      setMessage({ kind: 'ok', text: kind === 'keep' ? 'OK — this statement’s balance was not added.' : `${item.accountName ?? 'Bank account'} is now in your Assets at ${money(item.closingBalance, item.currency)}.` });
      onApplied();
    } catch (e) {
      setMessage({ kind: 'error', text: `${e instanceof Error ? e.message : 'Nothing was changed.'}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3 rounded-card border border-line bg-white p-4" aria-labelledby="bank-balance-heading">
      <div>
        <h2 id="bank-balance-heading" className="text-base font-semibold text-ink">Add your bank balance to Assets</h2>
        <p className="mt-1 text-sm text-muted">Closing balances from bank statements you approved. A balance counts in your Net Worth only after you add it.</p>
      </div>
      {message && <p className={`text-sm ${message.kind === 'ok' ? 'text-trust' : 'text-risk'}`} role="status">{message.text}</p>}
      <ul className="divide-y">
        {data.items.map((item) => (
          <li key={item.accountId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm" data-testid={`bank-balance-${item.state}`}>
            <div>
              <p className="font-medium text-ink">{item.accountName ?? 'Bank account'} — {money(item.closingBalance, item.currency)}</p>
              <p className="text-xs text-muted">
                {item.asOf ? `Statement ending ${item.asOf}. ` : ''}
                {item.state === 'proposed' ? (item.linkedAsset ? `Currently ${money(item.linkedAsset.value, item.linkedAsset.currency)} in "${item.linkedAsset.name}".` : 'Not in your Net Worth yet.') : item.stateLabel}
              </p>
              {item.state === 'proposed' && !item.linkedAsset && item.possibleDuplicates.length > 0 && (
                <label className="mt-1 block text-xs text-muted">
                  Already tracking this account as a cash asset?{' '}
                  <select value={target[item.accountId] ?? ''} onChange={(e) => setTarget((t) => ({ ...t, [item.accountId]: e.target.value }))} className="ml-1 rounded border px-2 py-0.5 text-xs">
                    <option value="">No — add it as a new asset</option>
                    {item.possibleDuplicates.map((d) => (
                      <option key={d.id} value={d.id}>Yes — update “{d.name}” ({money(d.value, d.currency)})</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {item.state === 'proposed' && (
              <div className="flex items-center gap-2">
                <button type="button" disabled={busy !== null || disabled} onClick={() => void act(item, 'apply')} className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
                  {busy === item.accountId ? 'Saving…' : item.linkedAsset || target[item.accountId] ? 'Update asset' : 'Add to Assets'}
                </button>
                <button type="button" disabled={busy !== null || disabled} onClick={() => void act(item, 'keep')} className="text-xs text-muted hover:underline disabled:opacity-50">Not now</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
