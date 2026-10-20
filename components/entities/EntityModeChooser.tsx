'use client';

import { useId, useState } from 'react';
import { fetchJson, formatMoneySafe } from '@/components/retirement/smsf/format';

type Currency = 'AUD' | 'INR';
export type EntityRecordingMode = 'summary' | 'detailed';

interface SwitchResult {
  status: 'preview' | 'applied';
  net_before: number | null;
  net_after: number | null;
  variance: number;
}

export const ENTITY_NET_ONLY_NOTE = 'A single net value hides what the entity owns and owes. FHIP cannot show its debts or how it changes when a loan is repaid.';

/**
 * "How do you want to record this entity?" (PO decision 17-10-2026, the same either-or as the SMSF): ITEMISED (assets and liabilities, the net is worked
 * out for you) OR a NET VALUE ONLY, never both. The database enforces the rule (migration 0297). Choosing the other way opens a small form, PREVIEWS the
 * effect (nothing changes) and only a second, explicit click applies it. What was retired is kept in the history, never deleted.
 */
export function EntityModeChooser({
  entityId,
  mode,
  currency,
  onChanged,
}: {
  entityId: string;
  mode: EntityRecordingMode;
  currency: Currency;
  onChanged: () => void;
}) {
  const uid = useId();
  const [target, setTarget] = useState<EntityRecordingMode | null>(null);
  const [net, setNet] = useState('');
  const [assetLabel, setAssetLabel] = useState('');
  const [assetValue, setAssetValue] = useState('');
  const [liabilityLabel, setLiabilityLabel] = useState('');
  const [liabilityValue, setLiabilityValue] = useState('');
  const [preview, setPreview] = useState<SwitchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checked = target ?? mode;
  const field = 'mt-1 w-full max-w-xs rounded border border-line px-2 py-1.5 text-sm';

  function choose(next: EntityRecordingMode) {
    setError(null);
    setPreview(null);
    setTarget(next === mode ? null : next);
  }

  function body(confirm: boolean) {
    if (target === 'detailed') {
      return {
        to_mode: 'detailed',
        assets: assetLabel.trim() !== '' || assetValue !== '' ? [{ label: assetLabel.trim(), value: Number(assetValue), currency_code: currency }] : [],
        liabilities: liabilityLabel.trim() !== '' || liabilityValue !== '' ? [{ label: liabilityLabel.trim(), value: Number(liabilityValue), currency_code: currency }] : [],
        confirm,
      };
    }
    return { to_mode: 'summary', net: Number(net), confirm };
  }

  async function run(confirm: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await fetchJson<SwitchResult>(`/api/business-entities/${entityId}/switch-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(confirm)) });
      if (confirm) {
        setTarget(null);
        setPreview(null);
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

  const ready = target === 'detailed' ? (assetValue !== '' && Number(assetValue) >= 0) || (liabilityValue !== '' && Number(liabilityValue) >= 0) : net !== '';

  return (
    <fieldset className="rounded-card border border-line p-3" data-testid="entity-mode-chooser">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">How do you want to record this entity?</legend>
      <div className="space-y-1 text-sm">
        <label className="flex items-start gap-2">
          <input type="radio" name={`${uid}-mode`} checked={checked === 'detailed'} onChange={() => choose('detailed')} className="mt-1" />
          <span>Itemised assets and liabilities (recommended)</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name={`${uid}-mode`} checked={checked === 'summary'} onChange={() => choose('summary')} className="mt-1" />
          <span>Net value only</span>
        </label>
      </div>
      <p className="mt-2 text-[11px] text-muted">{ENTITY_NET_ONLY_NOTE} Only one of these is ever counted.</p>

      {target && (
        <div className="mt-3 space-y-3 rounded-card border border-line bg-app p-3">
          {target === 'detailed' ? (
            <>
              <p className="text-sm font-medium text-ink">Enter at least one asset or liability to record this entity as itemised. You can add more afterwards.</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${uid}-al`} className="block text-xs text-muted">First asset: description</label>
                  <input id={`${uid}-al`} type="text" value={assetLabel} onChange={(e) => { setAssetLabel(e.target.value); setPreview(null); }} className={field} />
                </div>
                <div>
                  <label htmlFor={`${uid}-av`} className="block text-xs text-muted">First asset: value</label>
                  <input id={`${uid}-av`} type="number" inputMode="decimal" step="0.01" min={0} value={assetValue} onChange={(e) => { setAssetValue(e.target.value); setPreview(null); }} className={field} />
                </div>
                <div>
                  <label htmlFor={`${uid}-ll`} className="block text-xs text-muted">First liability: description (optional)</label>
                  <input id={`${uid}-ll`} type="text" value={liabilityLabel} onChange={(e) => { setLiabilityLabel(e.target.value); setPreview(null); }} className={field} />
                </div>
                <div>
                  <label htmlFor={`${uid}-lv`} className="block text-xs text-muted">First liability: amount owing (optional)</label>
                  <input id={`${uid}-lv`} type="number" inputMode="decimal" step="0.01" min={0} value={liabilityValue} onChange={(e) => { setLiabilityValue(e.target.value); setPreview(null); }} className={field} />
                </div>
              </div>
            </>
          ) : (
            <div>
              <label htmlFor={`${uid}-net`} className="block text-xs text-muted">Net value (assets minus debts)</label>
              <input id={`${uid}-net`} type="number" inputMode="decimal" step="0.01" value={net} onChange={(e) => { setNet(e.target.value); setPreview(null); }} className={field} />
              <p className="mt-1 text-[11px] text-muted">Your assets and liabilities are kept (not deleted) behind this value, and shown again if you switch back.</p>
            </div>
          )}

          {preview && (
            <div role="status" className="rounded border border-line bg-white p-3 text-sm" data-testid="entity-switch-preview">
              <p className="font-medium text-ink">Nothing has changed yet. This is what would happen:</p>
              <p className="mt-1">Net value now {formatMoneySafe(preview.net_before, currency)}, after the change {formatMoneySafe(preview.net_after, currency)}.</p>
              {preview.variance !== 0 && (
                <p className="mt-1 text-ink">The net would change by {formatMoneySafe(preview.variance, currency)}. Check that this is what you mean before you confirm.</p>
              )}
              <p className="mt-1 text-xs text-muted">The way it was recorded before is kept in the history.</p>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-risk">{error}</p>}
          <div className="flex items-center gap-3">
            {!preview ? (
              <button type="button" onClick={() => run(false)} disabled={!ready || busy} className="rounded border border-line bg-white px-4 py-1.5 text-sm text-ink hover:bg-gray-50 disabled:opacity-60">
                {busy ? 'Checking…' : 'Check the effect'}
              </button>
            ) : (
              <button type="button" onClick={() => run(true)} disabled={busy} className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">
                {busy ? 'Saving…' : 'Confirm the change'}
              </button>
            )}
            <button type="button" onClick={() => choose(mode)} className="text-sm text-muted hover:underline">Cancel</button>
          </div>
        </div>
      )}
    </fieldset>
  );
}
