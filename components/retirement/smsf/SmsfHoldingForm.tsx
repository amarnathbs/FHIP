'use client';

import { useState } from 'react';
import { fetchJson } from './format';
import {
  HOLDING_CLASS_OPTIONS,
  holdingTypeOptionsFor,
  type CountryCode,
  type CurrencyCode,
  type HoldingClass,
  type SmsfHoldingRow,
} from './types';

// Add/Edit Holding form (spec s.12-15). Standard FHIP Add-Entry-then-
// Saved-Items pattern (a single focused form, not a spreadsheet row) — the
// same shape SmsfDetailedWorkspace reuses for both "add new" and "edit
// existing" (spec s.15: edit must preserve the holding's id and update the
// same record, never duplicate it).
export function SmsfHoldingForm({
  fundId,
  currency,
  existing,
  onSaved,
  onCancel,
}: {
  fundId: string;
  currency: CurrencyCode;
  existing?: SmsfHoldingRow;
  onSaved: (holding: SmsfHoldingRow) => void;
  onCancel: () => void;
}) {
  const [holdingClass, setHoldingClass] = useState<HoldingClass>(existing?.holding_class ?? 'cash');
  const [holdingType, setHoldingType] = useState(existing?.holding_type ?? holdingTypeOptionsFor(existing?.holding_class ?? 'cash')[0].value);
  const [holdingName, setHoldingName] = useState(existing?.holding_name ?? '');
  const [value, setValue] = useState(existing?.value != null ? String(existing.value) : '');
  const [currencyCode, setCurrencyCode] = useState<CurrencyCode>(existing?.currency_code ?? currency);
  const [countryCode, setCountryCode] = useState<CountryCode | ''>(existing?.country_code ?? '');
  // A property asset that was tied to a personal income record the earlier way keeps that link until the record is moved into the fund. This form
  // never creates a new one: the rent a property earns is entered as the fund's own income, with an amount and how often it is paid.
  const legacyLinkedIncomeSourceId = existing?.linked_income_source_id ?? null;
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeOptions = holdingTypeOptionsFor(holdingClass);
  const canSubmit = holdingName.trim() !== '' && value !== '' && Number(value) >= 0 && currencyCode;

  function handleClassChange(next: HoldingClass) {
    setHoldingClass(next);
    setHoldingType(holdingTypeOptionsFor(next)[0].value);
  }

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const body = {
      holding_class: holdingClass,
      holding_type: holdingType,
      holding_name: holdingName,
      value: Number(value),
      currency_code: currencyCode,
      country_code: countryCode || null,
      linked_income_source_id: holdingClass === 'property' ? legacyLinkedIncomeSourceId : null,
      notes: notes || null,
    };
    try {
      const saved = existing
        ? await fetchJson<SmsfHoldingRow>(`/api/smsf/${fundId}/holdings/${existing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetchJson<SmsfHoldingRow>(`/api/smsf/${fundId}/holdings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this holding');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-app p-4">
      <h4 className="text-sm font-semibold text-ink">{existing ? 'Edit Holding' : 'Add Holding'}</h4>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="holding-class" className="block text-xs text-muted">
            Category
          </label>
          <select
            id="holding-class"
            value={holdingClass}
            onChange={(e) => handleClassChange(e.target.value as HoldingClass)}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          >
            {HOLDING_CLASS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="holding-type" className="block text-xs text-muted">
            Type
          </label>
          <select
            id="holding-type"
            value={holdingType}
            onChange={(e) => setHoldingType(e.target.value)}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          >
            {typeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="holding-name" className="block text-xs text-muted">
            {holdingClass === 'property' ? 'Property Name / Address / Reference' : 'Holding Name'}
          </label>
          <input
            id="holding-name"
            type="text"
            value={holdingName}
            onChange={(e) => setHoldingName(e.target.value)}
            placeholder={holdingClass === 'cash' ? 'e.g. ANZ SMSF Cash Account' : holdingClass === 'property' ? 'e.g. 12 Smith St, Perth WA' : 'e.g. BHP Group Ltd'}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label htmlFor="holding-value" className="block text-xs text-muted">
            {holdingClass === 'property' ? 'Market Value' : 'Current Value'}
          </label>
          <input
            id="holding-value"
            type="number"
            step="0.01"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label htmlFor="holding-currency" className="block text-xs text-muted">
            Currency
          </label>
          <select
            id="holding-currency"
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value as CurrencyCode)}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          >
            <option value="AUD">AUD</option>
            <option value="INR">INR</option>
          </select>
        </div>
        <div>
          <label htmlFor="holding-country" className="block text-xs text-muted">
            Market / Country
          </label>
          <select
            id="holding-country"
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value as CountryCode | '')}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          >
            <option value="">Not specified</option>
            <option value="AU">Australia</option>
            <option value="IN">India</option>
          </select>
        </div>
        {holdingClass === 'property' && (
          <p className="text-[11px] text-muted sm:col-span-2" data-testid="holding-rent-hint">
            {legacyLinkedIncomeSourceId
              ? 'The rent for this property is recorded the earlier way, in your personal Income. Move it into the fund under Income and expenses below so it lives in one place.'
              : 'Rent this property earns is entered under Income and expenses below, where you set the amount and how often it is paid. It is not entered here, so it is never counted twice.'}
          </p>
        )}
        <div className="sm:col-span-2">
          <label htmlFor="holding-notes" className="block text-xs text-muted">
            Notes
          </label>
          <input
            id="holding-notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-risk">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!canSubmit || saving}
          className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60"
        >
          {saving ? 'Saving…' : existing ? 'Save Changes' : 'Add Holding'}
        </button>
        <button onClick={onCancel} className="text-sm text-muted hover:underline">
          Cancel
        </button>
      </div>
    </div>
  );
}
