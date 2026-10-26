'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { fetchJson, formatMoneySafe } from '@/components/retirement/smsf/format';

type Currency = 'AUD' | 'INR';
export type EntityRecordingMode = 'summary' | 'detailed';

interface SwitchResult {
  status: 'preview' | 'applied';
  net_before: number | null;
  net_after: number | null;
  variance: number;
}

interface UndoPreview {
  status: 'preview' | 'applied';
  undoes: 'to_itemised' | 'to_net_only';
  to_mode: EntityRecordingMode;
  net_before: number | null;
  net_after: number | null;
  variance: number;
  will_archive?: { assets: number; liabilities: number };
  will_restore?: { assets: number; liabilities: number };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The plain sentence under the Undo confirmation: where the entity goes back to and what happens to its lines. Pure, so it is tested. */
export function entityUndoMessage(p: Pick<UndoPreview, 'to_mode' | 'net_before' | 'net_after' | 'will_archive' | 'will_restore'>, currency: Currency): string {
  const net = `Its net goes from ${formatMoneySafe(p.net_before, currency)} to ${formatMoneySafe(p.net_after, currency)}.`;
  if (p.to_mode === 'summary') {
    const a = p.will_archive ?? { assets: 0, liabilities: 0 };
    return `The entity goes back to a net value only. ${net} Its ${plural(a.assets, 'asset', 'assets')} and ${plural(a.liabilities, 'liability', 'liabilities')} are archived, not deleted, and kept in the history. Only the net value is counted afterwards.`;
  }
  const r = p.will_restore ?? { assets: 0, liabilities: 0 };
  return `The entity goes back to itemised assets and liabilities. ${net} ${plural(r.assets, 'asset', 'assets')} and ${plural(r.liabilities, 'liability', 'liabilities')} that you had before are brought back. The net value you typed is kept in the history, and only the itemised figures are counted afterwards.`;
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
  // The most recent switch can be undone while nothing newer was recorded (the database decides; this only decides whether to offer the button).
  const [canUndo, setCanUndo] = useState(false);
  const [undoPreview, setUndoPreview] = useState<UndoPreview | null>(null);

  const loadCanUndo = useCallback(async () => {
    try {
      const h = await fetchJson<{ modes: { action: string }[] }>(`/api/business-entities/${entityId}/history`);
      const newest = h.modes[0];
      setCanUndo(Boolean(newest && (newest.action === 'to_itemised' || newest.action === 'to_net_only')));
    } catch {
      setCanUndo(false);
    }
  }, [entityId]);
  useEffect(() => {
    // setState happens in the promise callback, not synchronously in the effect body.
    fetchJson<{ modes: { action: string }[] }>(`/api/business-entities/${entityId}/history`).then(
      (h) => setCanUndo(Boolean(h.modes[0] && (h.modes[0].action === 'to_itemised' || h.modes[0].action === 'to_net_only'))),
      () => setCanUndo(false),
    );
  }, [entityId, mode]);

  async function startUndo() {
    setBusy(true);
    setError(null);
    try {
      setUndoPreview(await fetchJson<UndoPreview>(`/api/business-entities/${entityId}/undo-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: false }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing can be undone right now');
      await loadCanUndo();
    } finally {
      setBusy(false);
    }
  }
  async function confirmUndo() {
    setBusy(true);
    try {
      await fetchJson(`/api/business-entities/${entityId}/undo-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      setUndoPreview(null);
      setTarget(null);
      setPreview(null);
      await loadCanUndo();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo');
      setUndoPreview(null);
    } finally {
      setBusy(false);
    }
  }

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

      {canUndo && !target && (
        <div className="mt-3 border-t border-line pt-3">
          <button type="button" onClick={() => void startUndo()} disabled={busy} className="rounded border border-line px-3 py-1 text-xs text-ink hover:bg-gray-50 disabled:opacity-60" data-testid="entity-undo-switch">
            Undo the last change
          </button>
          <p className="mt-1 text-[11px] text-muted">Goes back to how this entity was recorded before the last change. You see the effect first, nothing is deleted.</p>
        </div>
      )}
      {!target && error && <p role="alert" className="mt-2 text-sm text-risk">{error}</p>}

      <ConfirmDialog
        open={undoPreview !== null}
        title="Undo the last change?"
        message={undoPreview ? entityUndoMessage(undoPreview, currency) : ''}
        confirmLabel="Undo"
        destructive={false}
        onConfirm={() => void confirmUndo()}
        onCancel={() => setUndoPreview(null)}
      />
    </fieldset>
  );
}
