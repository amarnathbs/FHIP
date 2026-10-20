'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DateInput } from '@/components/ui/DateInput';
import { fetchJson, formatMoneySafe } from '@/components/retirement/smsf/format';
import { formatDateShort } from '@/lib/engines/date';
import { BUSINESS_ENTITY_ASSET_TYPES, BUSINESS_ENTITY_LIABILITY_TYPES } from '@/lib/validation/businessEntity';

type Currency = 'AUD' | 'INR';
type Kind = 'assets' | 'liabilities';

export interface EntityAssetLine {
  id: string;
  label: string;
  asset_type: string | null;
  value: number;
  currency_code: Currency;
  as_at_date: string | null;
  notes: string | null;
}
export interface EntityLiabilityLine {
  id: string;
  label: string;
  liability_type: string | null;
  lender: string | null;
  interest_rate: number | null;
  monthly_repayment: number | null;
  value: number;
  currency_code: Currency;
  as_at_date: string | null;
  notes: string | null;
}

const ASSET_LABELS: Record<string, string> = {
  cash: 'Cash',
  property: 'Property',
  shares_investments: 'Shares and investments',
  business_assets: 'Business assets',
  vehicle_equipment: 'Vehicles and equipment',
  other: 'Other',
};
const LIABILITY_LABELS: Record<string, string> = {
  property_loan: 'Property loan',
  other_loan: 'Other loan',
  tax_payable: 'Tax payable',
  trade_creditors: 'Trade creditors',
  other: 'Other debt',
};

/**
 * ITEMISED assets and liabilities of a Company, Family Trust or HUF (migration 0297): what the entity owns and what it owes, each with a type, an
 * as-at date and, for a liability, the lender, rate and repayment. The net is DERIVED (assets minus liabilities) and shown read only, it is never
 * typed here. A removed line is retired, never deleted, and stays in the change history. Shown only while the entity is recorded itemised.
 */
export function EntityLinesPanel({
  apiBase,
  currency,
  netDerived,
  onChanged,
}: {
  apiBase: string;
  currency: Currency;
  /** Derived by the database, or null while unknown. */
  netDerived: number | null;
  onChanged: () => void;
}) {
  const [assets, setAssets] = useState<EntityAssetLine[] | null>(null);
  const [liabilities, setLiabilities] = useState<EntityLiabilityLine[] | null>(null);
  const [form, setForm] = useState<{ kind: Kind; existing?: EntityAssetLine | EntityLiabilityLine } | null>(null);
  const [removing, setRemoving] = useState<{ kind: Kind; id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [a, l] = await Promise.all([fetchJson<EntityAssetLine[]>(`${apiBase}/assets`), fetchJson<EntityLiabilityLine[]>(`${apiBase}/liabilities`)]);
      setAssets(a);
      setLiabilities(l);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the assets and liabilities');
    }
  }, [apiBase]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const sum = (rows: { value: number; currency_code: string }[]) => rows.filter((r) => r.currency_code === currency).reduce((s, r) => s + Number(r.value), 0);
  const mixed = [...(assets ?? []), ...(liabilities ?? [])].some((r) => r.currency_code !== currency);
  const net = netDerived ?? (assets && liabilities ? sum(assets) - sum(liabilities) : null);

  async function remove() {
    const t = removing;
    setRemoving(null);
    if (!t) return;
    try {
      await fetchJson(`${apiBase}/${t.kind}/${t.id}`, { method: 'DELETE' });
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove this');
    }
  }

  const section = (kind: Kind, rows: (EntityAssetLine | EntityLiabilityLine)[]) => (
    <section aria-label={kind === 'assets' ? 'Assets of the entity' : 'Liabilities of the entity'} data-testid={`entity-${kind}`}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink">{kind === 'assets' ? 'Assets' : 'Liabilities'}</h4>
        {!form && (
          <button type="button" onClick={() => setForm({ kind })} className="text-sm font-medium text-trust hover:underline">
            {kind === 'assets' ? '+ Add asset' : '+ Add liability'}
          </button>
        )}
      </div>
      {rows.length === 0 && form?.kind !== kind && (
        <p className="mt-2 text-sm text-muted">{kind === 'assets' ? 'No assets entered yet.' : 'No liabilities entered. If the entity has a loan, add it so the net is right.'}</p>
      )}
      <ul className="mt-2 space-y-2">
        {rows.map((r) => {
          const a = r as EntityAssetLine;
          const l = r as EntityLiabilityLine;
          const type = kind === 'assets' ? a.asset_type : l.liability_type;
          const typeLabel = type ? (kind === 'assets' ? ASSET_LABELS[type] : LIABILITY_LABELS[type]) ?? type : null;
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-white p-3 text-sm">
              <div>
                <p className="font-medium text-ink">{r.label}</p>
                <p className="text-xs text-muted">
                  {[
                    typeLabel,
                    kind === 'liabilities' && l.lender ? l.lender : null,
                    kind === 'liabilities' && l.interest_rate != null ? `${l.interest_rate}%` : null,
                    kind === 'liabilities' && l.monthly_repayment != null ? `${formatMoneySafe(l.monthly_repayment, r.currency_code)} a month` : null,
                    r.as_at_date ? `as at ${formatDateShort(r.as_at_date, currency)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold tabular-nums text-ink">{formatMoneySafe(r.value, r.currency_code)}</span>
                <button type="button" onClick={() => setForm({ kind, existing: r })} className="text-xs text-trust hover:underline">Edit</button>
                <button type="button" onClick={() => setRemoving({ kind, id: r.id, label: r.label })} className="text-xs text-risk hover:underline">Remove</button>
              </div>
            </li>
          );
        })}
      </ul>
      {form?.kind === kind && (
        <LineForm
          key={form.existing?.id ?? 'new'}
          kind={kind}
          apiBase={apiBase}
          currency={currency}
          existing={form.existing}
          onSaved={() => {
            setForm(null);
            void reload();
            onChanged();
          }}
          onCancel={() => setForm(null)}
        />
      )}
    </section>
  );

  return (
    <div className="space-y-4" data-testid="entity-lines">
      <div className="rounded-card border border-line bg-app p-3 text-sm" aria-live="polite" data-testid="entity-net-derived">
        <p className="text-xs text-muted">Net position (worked out by FHIP, assets less liabilities)</p>
        <p className={`text-base font-semibold tabular-nums ${net !== null && net < 0 ? 'text-risk' : 'text-ink'}`}>
          {net === null ? '—' : formatMoneySafe(net, currency)}
          {net !== null && net < 0 && <span className="ml-2 text-xs font-normal">the entity owes more than it owns</span>}
        </p>
        <p className="mt-1 text-[11px] text-muted">You do not type the net. It changes when you add, change or remove an asset or a liability.{mixed ? ' Lines in another currency are converted at your reporting rate.' : ''}</p>
      </div>
      {assets && section('assets', assets)}
      {liabilities && section('liabilities', liabilities)}
      {error && <p role="alert" className="text-sm text-risk">{error}</p>}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this line?"
        message={`"${removing?.label ?? ''}" is removed from the entity and the net is worked out again. It stays in the change history.`}
        confirmLabel="Remove"
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

function LineForm({
  kind,
  apiBase,
  currency,
  existing,
  onSaved,
  onCancel,
}: {
  kind: Kind;
  apiBase: string;
  currency: Currency;
  existing?: EntityAssetLine | EntityLiabilityLine;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const isAsset = kind === 'assets';
  const ea = existing as EntityAssetLine | undefined;
  const el = existing as EntityLiabilityLine | undefined;
  const [label, setLabel] = useState(existing?.label ?? '');
  const [type, setType] = useState((isAsset ? ea?.asset_type : el?.liability_type) ?? '');
  const [value, setValue] = useState(existing ? String(existing.value) : '');
  const [currencyCode, setCurrencyCode] = useState<Currency>(existing?.currency_code ?? currency);
  const [asAt, setAsAt] = useState(existing?.as_at_date ?? '');
  const [lender, setLender] = useState(el?.lender ?? '');
  const [rate, setRate] = useState(el?.interest_rate != null ? String(el.interest_rate) : '');
  const [repayment, setRepayment] = useState(el?.monthly_repayment != null ? String(el.monthly_repayment) : '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = label.trim() !== '' && value !== '' && Number(value) >= 0;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = {
      label: label.trim(),
      value: Number(value),
      currency_code: currencyCode,
      as_at_date: asAt || null,
      notes: notes.trim() || null,
    };
    if (isAsset) body.asset_type = type || null;
    else {
      body.liability_type = type || null;
      body.lender = lender.trim() || null;
      body.interest_rate = rate === '' ? null : Number(rate);
      body.monthly_repayment = repayment === '' ? null : Number(repayment);
    }
    try {
      await fetchJson(existing ? `${apiBase}/${kind}/${existing.id}` : `${apiBase}/${kind}`, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this');
    } finally {
      setSaving(false);
    }
  }

  const field = 'mt-1 w-full rounded border border-line px-2 py-1.5 text-sm';
  const types = isAsset ? BUSINESS_ENTITY_ASSET_TYPES : BUSINESS_ENTITY_LIABILITY_TYPES;
  const labels = isAsset ? ASSET_LABELS : LIABILITY_LABELS;
  return (
    <div className="mt-3 rounded-card border border-line bg-app p-4">
      <h5 className="text-sm font-semibold text-ink">{existing ? 'Edit' : 'Add'} {isAsset ? 'an asset' : 'a liability'}</h5>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-type`} className="block text-xs text-muted">Type (optional)</label>
          <select id={`${uid}-type`} value={type} onChange={(e) => setType(e.target.value)} className={field}>
            <option value="">Not stated</option>
            {types.map((t) => (
              <option key={t} value={t}>{labels[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-label`} className="block text-xs text-muted">Description</label>
          <input id={`${uid}-label`} type="text" value={label} onChange={(e) => setLabel(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-value`} className="block text-xs text-muted">{isAsset ? 'Value' : 'Amount owing'}</label>
          <input id={`${uid}-value`} type="number" inputMode="decimal" step="0.01" min={0} value={value} onChange={(e) => setValue(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-asat`} className="block text-xs text-muted">As at (optional)</label>
          <DateInput id={`${uid}-asat`} value={asAt} onChange={(e) => setAsAt(e.target.value)} className={field} />
        </div>
        {!isAsset && (
          <>
            <div>
              <label htmlFor={`${uid}-lender`} className="block text-xs text-muted">Lender (optional)</label>
              <input id={`${uid}-lender`} type="text" value={lender} onChange={(e) => setLender(e.target.value)} className={field} />
            </div>
            <div>
              <label htmlFor={`${uid}-rate`} className="block text-xs text-muted">Interest rate % (optional)</label>
              <input id={`${uid}-rate`} type="number" inputMode="decimal" step="0.001" min={0} max={100} value={rate} onChange={(e) => setRate(e.target.value)} className={field} />
            </div>
            <div>
              <label htmlFor={`${uid}-repay`} className="block text-xs text-muted">Monthly repayment (optional)</label>
              <input id={`${uid}-repay`} type="number" inputMode="decimal" step="0.01" min={0} value={repayment} onChange={(e) => setRepayment(e.target.value)} className={field} />
            </div>
          </>
        )}
        <div>
          <label htmlFor={`${uid}-cur`} className="block text-xs text-muted">Currency</label>
          <select id={`${uid}-cur`} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value as Currency)} className={field}>
            <option value="AUD">AUD</option>
            <option value="INR">INR</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-notes`} className="block text-xs text-muted">Notes (optional)</label>
          <input id={`${uid}-notes`} type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={field} />
        </div>
      </div>
      {!isAsset && <p className="mt-2 text-[11px] text-muted">This is a debt of the entity, not yours. It reduces the entity&apos;s net and never appears in your personal liabilities or debt ratios.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-risk">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={submit} disabled={!canSubmit || saving} className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">
          {saving ? 'Saving…' : existing ? 'Save changes' : isAsset ? 'Add asset' : 'Add liability'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-muted hover:underline">Cancel</button>
      </div>
    </div>
  );
}
