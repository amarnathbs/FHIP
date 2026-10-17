'use client';

import { DateInput } from '@/components/ui/DateInput';
import { useState } from 'react';
import { fetchJson, type CurrencyCode } from './types';
import type { SmsfFundRow } from './types';

// New SMSF creation (spec s.4-7, s.10). Client-side AU gating is only ever
// a convenience — this form is not rendered at all unless SmsfSection has
// already confirmed country_of_residence === 'AU' — but the real gate is
// server-side (trg_retirement_accounts_smsf_au_gate, migration 0084) and
// this still surfaces a clean rejection message if that ever fires anyway
// (e.g. a stale client after a country change mid-session).
export function SmsfCreateForm({ onCreated, onCancel }: { onCreated: (fund: SmsfFundRow) => void; onCancel: () => void }) {
  const [accountName, setAccountName] = useState('');
  const [fundName, setFundName] = useState('');
  // Recording mode (PO decision 17-10-2026): itemised is the recommended default; a net value only is the alternative. Never both.
  const [mode, setMode] = useState<'detailed' | 'summary'>('detailed');
  const [balance, setBalance] = useState('');
  const [balanceDate, setBalanceDate] = useState('');
  const [owner, setOwner] = useState<'self' | 'spouse' | 'joint'>('self');
  const [currency, setCurrency] = useState<CurrencyCode>('AUD');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = accountName.trim() !== '' && fundName.trim() !== '' && (mode === 'detailed' || (balance !== '' && Number(balance) >= 0));

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const created = await fetchJson<{ retirement_account_id: string; smsf_fund_id: string }[]>('/api/smsf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_name: accountName,
          fund_name: fundName,
          mode,
          ...(mode === 'summary' ? { summary_balance: Number(balance), summary_balance_date: balanceDate || null } : {}),
          owner,
          currency_code: currency,
          country_code: 'AU',
        }),
      });
      // smsf_create_fund() is an RPC that returns a table (array of one row).
      const row = Array.isArray(created) ? created[0] : created;
      const fund = await fetchJson<SmsfFundRow>(`/api/smsf/${row.smsf_fund_id}`);
      onCreated(fund);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the SMSF');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-app p-4">
      <h3 className="text-sm font-semibold text-ink">Add an SMSF</h3>
      <fieldset className="mt-3">
        <legend className="text-xs font-semibold text-ink">How do you want to record this fund?</legend>
        <div className="mt-1 space-y-2">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name="smsf-create-mode" checked={mode === 'detailed'} onChange={() => setMode('detailed')} className="mt-1" />
            <span>
              <strong>Itemised assets and liabilities (recommended)</strong>
              <span className="block text-xs text-muted">You enter what the fund owns and owes next. FHIP works out the net, so there is no net value to type.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name="smsf-create-mode" checked={mode === 'summary'} onChange={() => setMode('summary')} className="mt-1" />
            <span>
              <strong>Net value only</strong>
              <span className="block text-xs text-muted">A single net value hides what the fund owns and owes. FHIP cannot show its debts or how it changes when a loan is repaid.</span>
            </span>
          </label>
        </div>
      </fieldset>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="smsf-account-name" className="block text-xs text-muted">
            Account Name
          </label>
          <input
            id="smsf-account-name"
            type="text"
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
            placeholder="e.g. Smith Family Super Fund"
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label htmlFor="smsf-fund-name" className="block text-xs text-muted">
            Fund Name
          </label>
          <input
            id="smsf-fund-name"
            type="text"
            value={fundName}
            onChange={(e) => setFundName(e.target.value)}
            placeholder="e.g. Smith Family SMSF"
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          />
        </div>
        {mode === 'summary' && (
          <>
            <div>
              <label htmlFor="smsf-balance" className="block text-xs text-muted">
                Net value (assets minus debts)
              </label>
              <input
                id="smsf-balance"
                type="number"
                step="0.01"
                min={0}
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor="smsf-balance-date" className="block text-xs text-muted">
                Valuation Date
              </label>
              <DateInput
                id="smsf-balance-date"
                value={balanceDate}
                onChange={(e) => setBalanceDate(e.target.value)}
                className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
              />
            </div>
          </>
        )}
        <div>
          <label htmlFor="smsf-owner" className="block text-xs text-muted">
            Owner
          </label>
          <select
            id="smsf-owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value as typeof owner)}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          >
            <option value="self">Self</option>
            <option value="spouse">Spouse/Partner</option>
            <option value="joint">Joint</option>
          </select>
        </div>
        <div>
          <label htmlFor="smsf-currency" className="block text-xs text-muted">
            Currency
          </label>
          <select
            id="smsf-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
            className="mt-1 w-full rounded border border-line px-2 py-1.5 text-sm"
          >
            <option value="AUD">AUD</option>
            <option value="INR">INR</option>
          </select>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted">
        {mode === 'detailed'
          ? 'This creates your SMSF with no figures yet. Add its assets and liabilities next; the net position is worked out for you and used in your family net worth.'
          : 'This creates your SMSF with a single net value, which FHIP uses in your retirement and family net worth. You can switch to itemised assets and liabilities at any time; what you had is kept in your history.'}
      </p>

      {error && <p className="mt-2 text-sm text-risk">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!canSubmit || saving}
          className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60"
        >
          {saving ? 'Creating…' : 'Create SMSF'}
        </button>
        <button onClick={onCancel} className="text-sm text-muted hover:underline">
          Cancel
        </button>
      </div>
    </div>
  );
}
