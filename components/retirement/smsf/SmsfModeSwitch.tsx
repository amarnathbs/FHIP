'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { DateInput } from '@/components/ui/DateInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { fetchJson, formatDateSafe, formatMoneySafe } from './format';
import {
  HOLDING_CLASS_OPTIONS,
  LIABILITY_TYPE_LABELS,
  MODE_LOG_LABELS,
  holdingTypeOptionsFor,
  type CurrencyCode,
  type HoldingClass,
  type SmsfFundRow,
  type SmsfLiabilityRow,
  type SmsfMode,
  type SmsfModeLogRow,
  type SmsfSwitchResult,
} from './types';

// "How do you want to record this fund?" (PO decision 17-10-2026): ITEMISED (assets and liabilities, the net is worked out for you) OR a
// NET VALUE ONLY, never both. The database enforces the rule (migration 0290); this screen only makes the choice clear and safe:
//   - choosing the other way opens a panel where the new figures are entered, PREVIEWS the effect (nothing changes), and only a second,
//     explicit click applies it;
//   - what was retired is archived (never deleted) and kept in the history, and the last change can be undone.

interface AssetDraft { holding_class: HoldingClass; holding_type: string; holding_name: string; value: string; currency_code: CurrencyCode }
interface LiabilityDraft { liability_name: string; liability_type: SmsfLiabilityRow['liability_type']; lender: string; balance: string; interest_rate: string; monthly_repayment: string; currency_code: CurrencyCode }

const emptyAsset = (currency: CurrencyCode): AssetDraft => ({ holding_class: 'property', holding_type: 'residential_property', holding_name: '', value: '', currency_code: currency });
const emptyLiability = (currency: CurrencyCode): LiabilityDraft => ({ liability_name: '', liability_type: 'property_loan', lender: '', balance: '', interest_rate: '', monthly_repayment: '', currency_code: currency });

export const NET_ONLY_NOTE = 'A single net value hides what the fund owns and owes. FHIP cannot show its debts or how it changes when a loan is repaid.';

export function SmsfModeSwitch({ fund, refreshKey, onChanged }: { fund: SmsfFundRow; refreshKey: number; onChanged: () => void }) {
  const uid = useId();
  const [target, setTarget] = useState<SmsfMode | null>(null);
  const [assets, setAssets] = useState<AssetDraft[]>([emptyAsset(fund.currency_code)]);
  const [liabilities, setLiabilities] = useState<LiabilityDraft[]>([]);
  const [net, setNet] = useState('');
  const [netDate, setNetDate] = useState('');
  const [preview, setPreview] = useState<SmsfSwitchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SmsfModeLogRow[]>([]);
  const [undoPreview, setUndoPreview] = useState<SmsfSwitchResult | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await fetchJson<SmsfModeLogRow[]>(`/api/smsf/${fund.id}/history`));
    } catch {
      setHistory([]);
    }
  }, [fund.id]);
  useEffect(() => {
    // setState happens in the promise callback, not synchronously in the effect body.
    fetchJson<SmsfModeLogRow[]>(`/api/smsf/${fund.id}/history`).then(setHistory, () => setHistory([]));
  }, [fund.id, refreshKey]);

  const lastSwitch = history[0] && (history[0].action === 'to_itemised' || history[0].action === 'to_net_only') ? history[0] : null;
  const checked = target ?? fund.mode;

  function choose(next: SmsfMode) {
    setError(null);
    setPreview(null);
    setTarget(next === fund.mode ? null : next);
  }

  function body(confirm: boolean) {
    if (target === 'detailed') {
      return {
        to_mode: 'detailed',
        assets: assets
          .filter((a) => a.holding_name.trim() !== '' || a.value !== '')
          .map((a) => ({ holding_class: a.holding_class, holding_type: a.holding_type, holding_name: a.holding_name.trim(), value: Number(a.value), currency_code: a.currency_code })),
        liabilities: liabilities
          .filter((l) => l.liability_name.trim() !== '' || l.balance !== '')
          .map((l) => ({
            liability_name: l.liability_name.trim(),
            liability_type: l.liability_type,
            lender: l.lender.trim() || null,
            balance: Number(l.balance),
            interest_rate: l.interest_rate === '' ? null : Number(l.interest_rate),
            monthly_repayment: l.monthly_repayment === '' ? null : Number(l.monthly_repayment),
            currency_code: l.currency_code,
          })),
        confirm,
      };
    }
    return { to_mode: 'summary', net: Number(net), net_date: netDate || null, confirm };
  }

  async function run(confirm: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await fetchJson<SmsfSwitchResult>(`/api/smsf/${fund.id}/switch-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(confirm)) });
      if (confirm) {
        setTarget(null);
        setPreview(null);
        await loadHistory();
        onChanged();
      } else {
        setPreview(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check this change');
    } finally {
      setBusy(false);
    }
  }

  async function startUndo() {
    setBusy(true);
    setError(null);
    try {
      setUndoPreview(await fetchJson<SmsfSwitchResult>(`/api/smsf/${fund.id}/undo-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: false }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing can be undone right now');
    } finally {
      setBusy(false);
    }
  }
  async function confirmUndo() {
    setBusy(true);
    try {
      await fetchJson(`/api/smsf/${fund.id}/undo-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      setUndoPreview(null);
      await loadHistory();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo');
      setUndoPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const draftChanged = () => setPreview(null);
  const canPreview =
    target === 'detailed'
      ? assets.some((a) => a.holding_name.trim() !== '' && a.value !== '') || liabilities.some((l) => l.liability_name.trim() !== '' && l.balance !== '')
      : target === 'summary'
        ? net !== '' && Number(net) >= 0
        : false;
  const field = 'mt-1 w-full rounded border border-line px-2 py-1.5 text-sm';

  return (
    <div className="space-y-3">
      <fieldset className="rounded-card border border-line bg-white p-3">
        <legend className="px-1 text-sm font-semibold text-ink">How do you want to record this fund?</legend>
        <div className="mt-1 space-y-2">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name={`${uid}-mode`} checked={checked === 'detailed'} onChange={() => choose('detailed')} className="mt-1" />
            <span>
              <strong>Itemised assets and liabilities (recommended)</strong>
              <span className="block text-xs text-muted">You enter what the fund owns and what it owes. FHIP works out the net. There is no net value to type.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name={`${uid}-mode`} checked={checked === 'summary'} onChange={() => choose('summary')} className="mt-1" />
            <span>
              <strong>Net value only</strong>
              <span className="block text-xs text-muted">{NET_ONLY_NOTE}</span>
            </span>
          </label>
        </div>
        <p className="mt-2 text-[11px] text-muted">Only one of these is ever counted. Changing it shows you the effect first, keeps what you had in your history, and can be undone.</p>
      </fieldset>

      {target === 'detailed' && (
        <div className="rounded-card border border-line bg-app p-3" aria-label="Switch to itemised assets and liabilities">
          <h4 className="text-sm font-semibold text-ink">Enter the fund&apos;s assets and liabilities</h4>
          <p className="mt-1 text-xs text-muted">The net value you have typed so far is kept in your history and removed from the figures once you confirm.</p>

          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Assets</p>
          {assets.map((a, i) => (
            <div key={i} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
              <div>
                <label htmlFor={`${uid}-ac-${i}`} className="block text-xs text-muted">Category</label>
                <select id={`${uid}-ac-${i}`} value={a.holding_class} onChange={(e) => { const c = e.target.value as HoldingClass; setAssets((r) => r.map((x, j) => (j === i ? { ...x, holding_class: c, holding_type: holdingTypeOptionsFor(c)[0].value } : x))); draftChanged(); }} className={field}>
                  {HOLDING_CLASS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-at-${i}`} className="block text-xs text-muted">Type</label>
                <select id={`${uid}-at-${i}`} value={a.holding_type} onChange={(e) => { setAssets((r) => r.map((x, j) => (j === i ? { ...x, holding_type: e.target.value } : x))); draftChanged(); }} className={field}>
                  {holdingTypeOptionsFor(a.holding_class).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor={`${uid}-an-${i}`} className="block text-xs text-muted">Description</label>
                <input id={`${uid}-an-${i}`} type="text" value={a.holding_name} onChange={(e) => { setAssets((r) => r.map((x, j) => (j === i ? { ...x, holding_name: e.target.value } : x))); draftChanged(); }} className={field} />
              </div>
              <div>
                <label htmlFor={`${uid}-av-${i}`} className="block text-xs text-muted">Value</label>
                <input id={`${uid}-av-${i}`} type="number" inputMode="decimal" step="0.01" min={0} value={a.value} onChange={(e) => { setAssets((r) => r.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))); draftChanged(); }} className={field} />
              </div>
              <div className="flex items-end">
                <button type="button" onClick={() => { setAssets((r) => r.filter((_, j) => j !== i)); draftChanged(); }} className="text-xs text-risk hover:underline">Remove</button>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => { setAssets((r) => [...r, emptyAsset(fund.currency_code)]); draftChanged(); }} className="mt-2 text-sm font-medium text-trust hover:underline">+ Add asset</button>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Liabilities</p>
          {liabilities.length === 0 && <p className="mt-1 text-xs text-muted">None entered. Add the fund&apos;s loans and other debts here.</p>}
          {liabilities.map((l, i) => (
            <div key={i} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
              <div>
                <label htmlFor={`${uid}-lt-${i}`} className="block text-xs text-muted">Type</label>
                <select id={`${uid}-lt-${i}`} value={l.liability_type} onChange={(e) => { setLiabilities((r) => r.map((x, j) => (j === i ? { ...x, liability_type: e.target.value as LiabilityDraft['liability_type'] } : x))); draftChanged(); }} className={field}>
                  {Object.entries(LIABILITY_TYPE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-ln-${i}`} className="block text-xs text-muted">Description</label>
                <input id={`${uid}-ln-${i}`} type="text" value={l.liability_name} onChange={(e) => { setLiabilities((r) => r.map((x, j) => (j === i ? { ...x, liability_name: e.target.value } : x))); draftChanged(); }} className={field} />
              </div>
              <div>
                <label htmlFor={`${uid}-ll-${i}`} className="block text-xs text-muted">Lender</label>
                <input id={`${uid}-ll-${i}`} type="text" value={l.lender} onChange={(e) => { setLiabilities((r) => r.map((x, j) => (j === i ? { ...x, lender: e.target.value } : x))); draftChanged(); }} className={field} />
              </div>
              <div>
                <label htmlFor={`${uid}-lb-${i}`} className="block text-xs text-muted">Amount owing</label>
                <input id={`${uid}-lb-${i}`} type="number" inputMode="decimal" step="0.01" min={0} value={l.balance} onChange={(e) => { setLiabilities((r) => r.map((x, j) => (j === i ? { ...x, balance: e.target.value } : x))); draftChanged(); }} className={field} />
              </div>
              <div>
                <label htmlFor={`${uid}-lr-${i}`} className="block text-xs text-muted">Rate % (optional)</label>
                <input id={`${uid}-lr-${i}`} type="number" inputMode="decimal" step="0.001" min={0} max={100} value={l.interest_rate} onChange={(e) => { setLiabilities((r) => r.map((x, j) => (j === i ? { ...x, interest_rate: e.target.value } : x))); draftChanged(); }} className={field} />
              </div>
              <div className="flex items-end">
                <button type="button" onClick={() => { setLiabilities((r) => r.filter((_, j) => j !== i)); draftChanged(); }} className="text-xs text-risk hover:underline">Remove</button>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => { setLiabilities((r) => [...r, emptyLiability(fund.currency_code)]); draftChanged(); }} className="mt-2 text-sm font-medium text-trust hover:underline">+ Add liability</button>
        </div>
      )}

      {target === 'summary' && (
        <div className="rounded-card border border-line bg-app p-3" aria-label="Switch to a net value only">
          <h4 className="text-sm font-semibold text-ink">Enter the fund&apos;s net value</h4>
          <p className="mt-1 text-xs text-muted">{NET_ONLY_NOTE} Your assets and liabilities are archived, kept in your history, and can be brought back with Undo.</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-net`} className="block text-xs text-muted">Net value (assets minus debts)</label>
              <input id={`${uid}-net`} type="number" inputMode="decimal" step="0.01" min={0} value={net} onChange={(e) => { setNet(e.target.value); draftChanged(); }} className={field} />
            </div>
            <div>
              <label htmlFor={`${uid}-date`} className="block text-xs text-muted">Valuation date (optional)</label>
              <DateInput id={`${uid}-date`} value={netDate} onChange={(e) => { setNetDate(e.target.value); draftChanged(); }} className={field} />
            </div>
          </div>
        </div>
      )}

      {target && (
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => run(false)} disabled={!canPreview || busy} className="rounded border border-trust px-4 py-1.5 text-sm font-medium text-trust disabled:opacity-60">
              {busy && !preview ? 'Checking…' : 'Check the effect'}
            </button>
            <button type="button" onClick={() => { setTarget(null); setPreview(null); }} className="text-sm text-muted hover:underline">Cancel</button>
          </div>
          {preview && (
            <div role="status" className="mt-3 rounded-card border border-line bg-white p-3 text-sm">
              <p className="font-medium text-ink">Nothing has changed yet. If you confirm:</p>
              <p className="mt-1 text-ink">
                The fund&apos;s net goes from <strong>{formatMoneySafe(preview.net_before, fund.currency_code)}</strong> to <strong>{formatMoneySafe(preview.net_after, fund.currency_code)}</strong>
                {preview.variance === 0 ? ' (no change).' : ` (a change of ${formatMoneySafe(preview.variance, fund.currency_code)}).`}
              </p>
              <p className="mt-1 text-xs text-muted">What you had before is archived, not deleted, and is kept in your history.</p>
              <button type="button" onClick={() => run(true)} disabled={busy} className="mt-2 rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">
                {busy ? 'Applying…' : 'Confirm and switch'}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-risk">{error}</p>}

      {(lastSwitch || history.length > 0) && (
        <details className="rounded-card border border-line bg-white p-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">Mode history</summary>
          {lastSwitch && (
            <button type="button" onClick={startUndo} disabled={busy} className="mt-2 rounded border border-line px-3 py-1 text-xs text-ink hover:bg-gray-50 disabled:opacity-60">
              Undo the last change
            </button>
          )}
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {history.map((h) => (
              <li key={h.id}>
                {formatDateSafe(h.created_at.slice(0, 10))}: {MODE_LOG_LABELS[h.action]}
                {h.net_before !== null && h.net_after !== null ? ` (net ${formatMoneySafe(h.net_before, fund.currency_code)} to ${formatMoneySafe(h.net_after, fund.currency_code)})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      <ConfirmDialog
        open={undoPreview !== null}
        title="Undo the last change?"
        message={`The fund goes back to how it was recorded before. Its net goes from ${formatMoneySafe(undoPreview?.net_before ?? null, fund.currency_code)} to ${formatMoneySafe(undoPreview?.net_after ?? null, fund.currency_code)}. Nothing is deleted.`}
        confirmLabel="Undo"
        destructive={false}
        onConfirm={confirmUndo}
        onCancel={() => setUndoPreview(null)}
      />
    </div>
  );
}
