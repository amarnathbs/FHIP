'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { fetchJson, formatMoneySafe } from '@/components/retirement/smsf/format';
import { toMonthly, FREQUENCY_OPTIONS, type Frequency } from '@/lib/engines/money';
import {
  ENTITY_EXPENSE_TYPES,
  ENTITY_EXPENSE_TYPE_LABELS,
  ENTITY_INCOME_TYPES,
  ENTITY_INCOME_TYPE_LABELS,
  type EntityExpenseType,
  type EntityIncomeType,
} from '@/lib/validation/entityCashFlow';

type Currency = 'AUD' | 'INR';

interface FlowRow {
  id: string;
  income_type?: EntityIncomeType;
  income_name?: string;
  expense_type?: EntityExpenseType;
  expense_name?: string;
  amount: number;
  frequency: Frequency;
  currency_code: Currency;
  smsf_holding_id?: string | null;
  business_entity_asset_id?: string | null;
  notes: string | null;
}

const FREQ_LABEL: Record<string, string> = Object.fromEntries(FREQUENCY_OPTIONS.map((f) => [f.value, f.label.toLowerCase()]));

/**
 * ENTITY-LEVEL income or expenses for ONE entity (an SMSF fund or a Company, Family Trust or HUF): the same panel for both, because one behaviour in
 * two places would drift (PO review 20-10-2026, F22 / F23 / F23b). Everything here is scoped to the entity through `apiBase`
 * (/api/smsf/[id] or /api/business-entities/[id]); none of it is ever part of personal Income or Expenses.
 *
 * RENT needs an amount AND how often it is paid (the PO could pick "weekly" but never type the rent). Rent may be tied to the property it comes
 * from, and a property has ONE rent record, so the same flow is never in two places.
 */
export function EntityFlowPanel({
  flow,
  apiBase,
  currency,
  assetLinkField,
  assetOptions = [],
  onChanged,
}: {
  flow: 'income' | 'expenses';
  apiBase: string;
  currency: Currency;
  assetLinkField?: 'smsf_holding_id' | 'business_entity_asset_id';
  /** Property assets of the entity a rent record can be tied to. */
  assetOptions?: { id: string; name: string }[];
  onChanged?: () => void;
}) {
  const isIncome = flow === 'income';
  const uid = useId();
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<{ existing?: FlowRow } | null>(null);
  const [removing, setRemoving] = useState<FlowRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await fetchJson<FlowRow[]>(`${apiBase}/${flow}`));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load this');
    }
  }, [apiBase, flow]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const typeOf = (r: FlowRow) => (isIncome ? r.income_type : r.expense_type) as string;
  const nameOf = (r: FlowRow) => (isIncome ? r.income_name : r.expense_name) ?? '';
  const labelOf = (t: string) => (isIncome ? ENTITY_INCOME_TYPE_LABELS[t as EntityIncomeType] : ENTITY_EXPENSE_TYPE_LABELS[t as EntityExpenseType]) ?? t;
  const monthlyTotal = (rows ?? []).filter((r) => r.currency_code === currency).reduce((s, r) => s + toMonthly(Number(r.amount), r.frequency), 0);
  const leftOut = (rows ?? []).filter((r) => r.currency_code !== currency).length;
  const title = isIncome ? 'Income' : 'Expenses';
  const noun = isIncome ? 'income' : 'expense';

  async function remove(row: FlowRow) {
    setError(null);
    try {
      await fetchJson(`${apiBase}/${flow}/${row.id}`, { method: 'DELETE' });
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove this');
    }
  }

  return (
    <section aria-label={`${title} of this entity`} data-testid={`entity-${flow}-panel`}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        {!form && (
          <button type="button" onClick={() => setForm({})} className="text-sm font-medium text-trust hover:underline">
            {isIncome ? '+ Add income' : '+ Add expense'}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        {isIncome
          ? 'Rent, interest, dividends, distributions and other income of this entity. It stays here and never appears in your personal Income.'
          : 'Recurring costs of this entity. A loan repayment is not entered here: record the loan under Liabilities and FHIP works out the repayment and the interest.'}
      </p>
      {loadError && <p role="alert" className="mt-2 text-sm text-risk">{loadError}</p>}
      {rows && rows.length === 0 && !form && <p className="mt-2 text-sm text-muted">{isIncome ? 'No income recorded yet.' : 'No expenses recorded yet.'}</p>}
      <ul className="mt-2 space-y-2">
        {(rows ?? []).map((r) => {
          const linked = assetOptions.find((a) => a.id === (r.smsf_holding_id ?? r.business_entity_asset_id));
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-white p-3 text-sm">
              <div>
                <p className="font-medium text-ink">{nameOf(r)}</p>
                <p className="text-xs text-muted">
                  {labelOf(typeOf(r))}
                  {linked ? ` · from ${linked.name}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold tabular-nums text-ink">
                  {formatMoneySafe(r.amount, r.currency_code)} <span className="font-normal text-muted">{FREQ_LABEL[r.frequency] ?? r.frequency}</span>
                </span>
                <button type="button" onClick={() => setForm({ existing: r })} className="text-xs text-trust hover:underline">Edit</button>
                <button type="button" onClick={() => setRemoving(r)} className="text-xs text-risk hover:underline">Remove</button>
              </div>
            </li>
          );
        })}
      </ul>
      {rows && rows.length > 0 && (
        <p className="mt-2 text-xs text-muted" data-testid={`entity-${flow}-monthly`}>
          About {formatMoneySafe(Math.round(monthlyTotal * 100) / 100, currency)} a month in total
          {leftOut > 0 ? `. ${leftOut} in another currency ${leftOut === 1 ? 'is' : 'are'} left out of this total, not counted as zero.` : '.'}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-risk">{error}</p>}
      {form && (
        <FlowForm
          key={form.existing?.id ?? 'new'}
          idPrefix={`${uid}-${flow}`}
          isIncome={isIncome}
          apiBase={apiBase}
          flow={flow}
          currency={currency}
          assetLinkField={assetLinkField}
          assetOptions={assetOptions}
          existing={form.existing}
          takenAssetIds={(rows ?? []).filter((r) => r.id !== form.existing?.id).map((r) => r.smsf_holding_id ?? r.business_entity_asset_id).filter((x): x is string => !!x)}
          onSaved={() => {
            setForm(null);
            void reload();
            onChanged?.();
          }}
          onCancel={() => setForm(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove this ${noun}?`}
        message={`"${removing ? nameOf(removing) : ''}" is removed from this entity. It stays in the change history.`}
        confirmLabel="Remove"
        onConfirm={async () => {
          const target = removing;
          setRemoving(null);
          if (target) await remove(target);
        }}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}

function FlowForm({
  idPrefix,
  isIncome,
  apiBase,
  flow,
  currency,
  assetLinkField,
  assetOptions,
  existing,
  takenAssetIds,
  onSaved,
  onCancel,
}: {
  idPrefix: string;
  isIncome: boolean;
  apiBase: string;
  flow: 'income' | 'expenses';
  currency: Currency;
  assetLinkField?: 'smsf_holding_id' | 'business_entity_asset_id';
  assetOptions: { id: string; name: string }[];
  existing?: FlowRow;
  takenAssetIds: string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const types = (isIncome ? ENTITY_INCOME_TYPES : ENTITY_EXPENSE_TYPES) as readonly string[];
  const [type, setType] = useState<string>((isIncome ? existing?.income_type : existing?.expense_type) ?? (isIncome ? 'rent' : 'other'));
  const [name, setName] = useState((isIncome ? existing?.income_name : existing?.expense_name) ?? '');
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '');
  const [frequency, setFrequency] = useState<Frequency>(existing?.frequency ?? (isIncome ? 'weekly' : 'monthly'));
  const [currencyCode, setCurrencyCode] = useState<Currency>(existing?.currency_code ?? currency);
  const [assetId, setAssetId] = useState(existing?.smsf_holding_id ?? existing?.business_entity_asset_id ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRent = isIncome && type === 'rent';
  const amountNum = Number(amount);
  const rentIncomplete = isRent && !(amountNum > 0);
  const canSubmit = name.trim() !== '' && amount !== '' && amountNum >= 0 && !rentIncomplete;
  const availableAssets = assetOptions.filter((a) => !takenAssetIds.includes(a.id));

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = {
      [isIncome ? 'income_type' : 'expense_type']: type,
      [isIncome ? 'income_name' : 'expense_name']: name.trim(),
      amount: amountNum,
      frequency,
      currency_code: currencyCode,
      notes: notes.trim() || null,
    };
    if (isIncome && assetLinkField) body[assetLinkField] = isRent && assetId ? assetId : null;
    try {
      await fetchJson(existing ? `${apiBase}/${flow}/${existing.id}` : `${apiBase}/${flow}`, {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this');
    } finally {
      setSaving(false);
    }
  }

  const field = 'mt-1 w-full rounded border border-line px-2 py-1.5 text-sm';
  return (
    <div className="mt-3 rounded-card border border-line bg-app p-4">
      <h5 className="text-sm font-semibold text-ink">{existing ? `Edit ${isIncome ? 'income' : 'expense'}` : isIncome ? 'Add income' : 'Add an expense'}</h5>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-type`} className="block text-xs text-muted">Type</label>
          <select id={`${idPrefix}-type`} value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {types.map((t) => (
              <option key={t} value={t}>{isIncome ? ENTITY_INCOME_TYPE_LABELS[t as EntityIncomeType] : ENTITY_EXPENSE_TYPE_LABELS[t as EntityExpenseType]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-name`} className="block text-xs text-muted">Description</label>
          <input id={`${idPrefix}-name`} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={isRent ? 'e.g. Rent, Unit 1' : ''} className={field} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-amount`} className="block text-xs text-muted">{isRent ? 'Rent amount' : 'Amount'}</label>
          <input id={`${idPrefix}-amount`} type="number" inputMode="decimal" step="0.01" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={rentIncomplete && amount !== ''} className={field} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-freq`} className="block text-xs text-muted">{isRent ? 'How often the rent is paid' : 'How often'}</label>
          <select id={`${idPrefix}-freq`} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className={field}>
            {FREQUENCY_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
        {isRent && assetLinkField && (
          <div>
            <label htmlFor={`${idPrefix}-asset`} className="block text-xs text-muted">Property this rent comes from (optional)</label>
            <select id={`${idPrefix}-asset`} value={assetId} onChange={(e) => setAssetId(e.target.value)} className={field}>
              <option value="">Not linked</option>
              {availableAssets.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted">A property has one rent record, so it is never counted twice.</p>
          </div>
        )}
        <div>
          <label htmlFor={`${idPrefix}-currency`} className="block text-xs text-muted">Currency</label>
          <select id={`${idPrefix}-currency`} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value as Currency)} className={field}>
            <option value="AUD">AUD</option>
            <option value="INR">INR</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-notes`} className="block text-xs text-muted">Notes (optional)</label>
          <input id={`${idPrefix}-notes`} type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={field} />
        </div>
      </div>
      {rentIncomplete && amount !== '' && <p role="alert" className="mt-2 text-xs text-risk">Enter the rent amount and how often it is paid.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-risk">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={submit} disabled={!canSubmit || saving} className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">
          {saving ? 'Saving…' : existing ? 'Save changes' : isIncome ? 'Add income' : 'Add expense'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-muted hover:underline">Cancel</button>
      </div>
    </div>
  );
}
