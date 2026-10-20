'use client';

import { useId, useState } from 'react';
import { DateInput } from '@/components/ui/DateInput';
import { fetchJson } from './format';
import { LIABILITY_TYPE_LABELS, type CurrencyCode, type SmsfHoldingRow, type SmsfLiabilityRow } from './types';

// Add / edit one SMSF liability (migrations 0289 and 0295): a debt of the FUND, entered on the fund itself, never in the personal Liabilities
// register (PO review 20-10-2026, F21). It carries the same fields as a personal liability (lender, rate, rate type, fixed-rate expiry,
// repayment, masked account reference, due date) plus the property it funds. The fund net is derived from the assets and these liabilities.
export function SmsfLiabilityForm({
  fundId,
  currency,
  existing,
  propertyHoldings = [],
  onSaved,
  onCancel,
}: {
  fundId: string;
  currency: CurrencyCode;
  existing?: SmsfLiabilityRow;
  /** The fund's property assets, so a loan can be tied to the property it funds. */
  propertyHoldings?: SmsfHoldingRow[];
  onSaved: (row: SmsfLiabilityRow) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [name, setName] = useState(existing?.liability_name ?? '');
  const [type, setType] = useState<SmsfLiabilityRow['liability_type']>(existing?.liability_type ?? 'property_loan');
  const [lender, setLender] = useState(existing?.lender ?? '');
  const [balance, setBalance] = useState(existing?.balance != null ? String(existing.balance) : '');
  const [rate, setRate] = useState(existing?.interest_rate != null ? String(existing.interest_rate) : '');
  const [rateType, setRateType] = useState<'' | 'fixed' | 'variable'>(existing?.interest_rate_type ?? '');
  const [fixedExpiry, setFixedExpiry] = useState(existing?.fixed_rate_expiry ?? '');
  const [repayment, setRepayment] = useState(existing?.monthly_repayment != null ? String(existing.monthly_repayment) : '');
  const [dueDate, setDueDate] = useState(existing?.due_date ?? '');
  const [masked, setMasked] = useState(existing?.masked_identifier ?? '');
  const [holdingId, setHoldingId] = useState(existing?.smsf_holding_id ?? '');
  const [currencyCode, setCurrencyCode] = useState<CurrencyCode>(existing?.currency_code ?? currency);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maskedTooLong = /[0-9]{7,}/.test(masked);
  const canSubmit = name.trim() !== '' && balance !== '' && Number(balance) >= 0 && !maskedTooLong;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const body = {
      liability_name: name.trim(),
      liability_type: type,
      lender: lender.trim() || null,
      balance: Number(balance),
      interest_rate: rate === '' ? null : Number(rate),
      interest_rate_type: rateType === '' ? null : rateType,
      fixed_rate_expiry: rateType === 'fixed' && fixedExpiry ? fixedExpiry : null,
      monthly_repayment: repayment === '' ? null : Number(repayment),
      due_date: dueDate || null,
      masked_identifier: masked.trim() || null,
      smsf_holding_id: type === 'property_loan' && holdingId ? holdingId : null,
      currency_code: currencyCode,
      notes: notes.trim() || null,
    };
    try {
      const saved = existing
        ? await fetchJson<SmsfLiabilityRow>(`/api/smsf/${fundId}/liabilities/${existing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetchJson<SmsfLiabilityRow>(`/api/smsf/${fundId}/liabilities`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this liability');
    } finally {
      setSaving(false);
    }
  }

  const field = 'mt-1 w-full rounded border border-line px-2 py-1.5 text-sm';
  return (
    <div className="rounded-card border border-line bg-app p-4">
      <h4 className="text-sm font-semibold text-ink">{existing ? 'Edit liability' : 'Add a liability of the fund'}</h4>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-type`} className="block text-xs text-muted">Type</label>
          <select id={`${uid}-type`} value={type} onChange={(e) => setType(e.target.value as SmsfLiabilityRow['liability_type'])} className={field}>
            {Object.entries(LIABILITY_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-name`} className="block text-xs text-muted">Description</label>
          <input id={`${uid}-name`} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Property loan" className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-lender`} className="block text-xs text-muted">Lender (optional)</label>
          <input id={`${uid}-lender`} type="text" value={lender} onChange={(e) => setLender(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-balance`} className="block text-xs text-muted">Outstanding balance</label>
          <input id={`${uid}-balance`} type="number" inputMode="decimal" step="0.01" min={0} value={balance} onChange={(e) => setBalance(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-rate`} className="block text-xs text-muted">Interest rate % (optional)</label>
          <input id={`${uid}-rate`} type="number" inputMode="decimal" step="0.001" min={0} max={100} value={rate} onChange={(e) => setRate(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-ratetype`} className="block text-xs text-muted">Rate type (optional)</label>
          <select id={`${uid}-ratetype`} value={rateType} onChange={(e) => setRateType(e.target.value as '' | 'fixed' | 'variable')} className={field}>
            <option value="">Not stated</option>
            <option value="fixed">Fixed</option>
            <option value="variable">Variable</option>
          </select>
        </div>
        {rateType === 'fixed' && (
          <div>
            <label htmlFor={`${uid}-fixedexpiry`} className="block text-xs text-muted">Fixed rate ends (optional)</label>
            <DateInput id={`${uid}-fixedexpiry`} value={fixedExpiry} onChange={(e) => setFixedExpiry(e.target.value)} className={field} />
          </div>
        )}
        <div>
          <label htmlFor={`${uid}-repay`} className="block text-xs text-muted">Monthly repayment (optional)</label>
          <input id={`${uid}-repay`} type="number" inputMode="decimal" step="0.01" min={0} value={repayment} onChange={(e) => setRepayment(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-due`} className="block text-xs text-muted">Next payment due (optional)</label>
          <DateInput id={`${uid}-due`} value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-masked`} className="block text-xs text-muted">Account number, last 4 digits (optional)</label>
          <input id={`${uid}-masked`} type="text" value={masked} onChange={(e) => setMasked(e.target.value)} maxLength={32} aria-invalid={maskedTooLong} aria-describedby={maskedTooLong ? `${uid}-masked-err` : undefined} className={field} />
          {maskedTooLong && <p id={`${uid}-masked-err`} role="alert" className="mt-1 text-xs text-risk">Enter only the last 4 digits of the account number, not the whole number.</p>}
        </div>
        {type === 'property_loan' && propertyHoldings.length > 0 && (
          <div>
            <label htmlFor={`${uid}-holding`} className="block text-xs text-muted">Property this loan funds (optional)</label>
            <select id={`${uid}-holding`} value={holdingId} onChange={(e) => setHoldingId(e.target.value)} className={field}>
              <option value="">Not linked</option>
              {propertyHoldings.map((h) => (
                <option key={h.id} value={h.id}>{h.holding_name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor={`${uid}-currency`} className="block text-xs text-muted">Currency</label>
          <select id={`${uid}-currency`} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value as CurrencyCode)} className={field}>
            <option value="AUD">AUD</option>
            <option value="INR">INR</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-notes`} className="block text-xs text-muted">Notes (optional)</label>
          <input id={`${uid}-notes`} type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={field} />
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted">This is a debt of the fund, not yours. It reduces the fund&apos;s net position and never appears in your personal liabilities. Linking it to a property only records which asset it funds, it does not change any amount.</p>
      {error && <p role="alert" className="mt-2 text-sm text-risk">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button onClick={submit} disabled={!canSubmit || saving} className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Add liability'}
        </button>
        <button onClick={onCancel} className="text-sm text-muted hover:underline">Cancel</button>
      </div>
    </div>
  );
}
