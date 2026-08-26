'use client';

import { useState } from 'react';

// Investment Intelligence R12 — the first live, user-facing manual entry
// UI for Investment Intelligence (R12_UI_UX_SPEC.md). Frozen to R12's
// scope: direct listed Indian equity + equity-oriented ETF (spec section
// 73 — "Add Investment flow should adapt based on asset type... only for
// approved R12 scope"). Deliberately a plain sub-section of the existing
// Investment Intelligence page, not a new top-level nav item (spec section
// 70).

type Action = 'buy' | 'sale' | 'dividend' | 'reprice';

interface Result {
  instrumentId: string;
  unitsAfter: number | null;
  valueAfter: number | null;
  taxClassificationSeeded: boolean;
}

export function ManualDirectPositionForm() {
  const [action, setAction] = useState<Action>('buy');
  const [instrumentClass, setInstrumentClass] = useState<'equity' | 'etf'>('equity');
  const [isEquityOriented, setIsEquityOriented] = useState(true);
  const [instrumentName, setInstrumentName] = useState('');
  const [isin, setIsin] = useState('');
  const [exchange, setExchange] = useState<'NSE' | 'BSE' | ''>('NSE');
  const [exchangeSymbol, setExchangeSymbol] = useState('');
  const [accountInstitutionName, setAccountInstitutionName] = useState('');
  const [transactionDate, setTransactionDate] = useState('');
  const [units, setUnits] = useState('');
  const [pricePerUnit, setPricePerUnit] = useState('');
  const [amount, setAmount] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);

    const base = {
      instrumentClass,
      isEquityOriented: instrumentClass === 'etf' ? isEquityOriented : undefined,
      instrumentName,
      isin,
      exchange: exchange || null,
      exchangeSymbol: exchangeSymbol || null,
      accountInstitutionName,
    };

    let body: Record<string, unknown>;
    if (action === 'buy' || action === 'sale') {
      body = { action, ...base, transactionDate, units: Number(units), pricePerUnit: Number(pricePerUnit) };
    } else if (action === 'dividend') {
      body = { action, ...base, transactionDate, amount: Number(amount) };
    } else {
      body = { action, ...base, asOfDate: transactionDate, currentValue: Number(currentValue) };
    }

    try {
      const res = await fetch('/api/investment-intelligence/positions/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Something went wrong.');
      } else {
        setResult(json.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-8 rounded-lg border border-gray-200 p-4">
      <h2 className="text-lg font-semibold text-gray-900">Add a direct equity or ETF position</h2>
      <p className="mt-1 text-sm text-gray-600">
        Manual entry for direct listed Indian equity and equity-oriented ETFs — the only asset classes R12 currently supports beyond mutual funds. Other
        asset classes (bonds, REITs, gold ETFs, etc.) are not yet available here.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col text-sm">
          Action
          <select className="mt-1 rounded border px-2 py-1" value={action} onChange={(e) => setAction(e.target.value as Action)}>
            <option value="buy">Buy</option>
            <option value="sale">Sell</option>
            <option value="dividend">Dividend received</option>
            <option value="reprice">Update current value</option>
          </select>
        </label>

        <label className="flex flex-col text-sm">
          Instrument class
          <select className="mt-1 rounded border px-2 py-1" value={instrumentClass} onChange={(e) => setInstrumentClass(e.target.value as 'equity' | 'etf')}>
            <option value="equity">Direct equity</option>
            <option value="etf">Equity-oriented ETF</option>
          </select>
        </label>

        {instrumentClass === 'etf' && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={isEquityOriented} onChange={(e) => setIsEquityOriented(e.target.checked)} />
            This ETF is equity-oriented (tracks a domestic equity index/sector) — required for R12 tax classification
          </label>
        )}

        <label className="flex flex-col text-sm">
          Security name
          <input className="mt-1 rounded border px-2 py-1" value={instrumentName} onChange={(e) => setInstrumentName(e.target.value)} required />
        </label>

        <label className="flex flex-col text-sm">
          ISIN
          <input className="mt-1 rounded border px-2 py-1" value={isin} onChange={(e) => setIsin(e.target.value.toUpperCase())} required />
        </label>

        <label className="flex flex-col text-sm">
          Exchange (optional)
          <select className="mt-1 rounded border px-2 py-1" value={exchange} onChange={(e) => setExchange(e.target.value as 'NSE' | 'BSE' | '')}>
            <option value="">—</option>
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Exchange symbol (optional)
          <input className="mt-1 rounded border px-2 py-1" value={exchangeSymbol} onChange={(e) => setExchangeSymbol(e.target.value.toUpperCase())} />
        </label>

        <label className="flex flex-col text-sm">
          Broker / demat account name
          <input className="mt-1 rounded border px-2 py-1" value={accountInstitutionName} onChange={(e) => setAccountInstitutionName(e.target.value)} required />
        </label>

        <label className="flex flex-col text-sm">
          {action === 'reprice' ? 'As of date' : 'Date'}
          <input type="date" className="mt-1 rounded border px-2 py-1" value={transactionDate} onChange={(e) => setTransactionDate(e.target.value)} required />
        </label>

        {(action === 'buy' || action === 'sale') && (
          <>
            <label className="flex flex-col text-sm">
              Units
              <input type="number" step="any" className="mt-1 rounded border px-2 py-1" value={units} onChange={(e) => setUnits(e.target.value)} required />
            </label>
            <label className="flex flex-col text-sm">
              Price per unit (INR)
              <input type="number" step="any" className="mt-1 rounded border px-2 py-1" value={pricePerUnit} onChange={(e) => setPricePerUnit(e.target.value)} required />
            </label>
          </>
        )}

        {action === 'dividend' && (
          <label className="flex flex-col text-sm">
            Dividend amount (INR)
            <input type="number" step="any" className="mt-1 rounded border px-2 py-1" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
        )}

        {action === 'reprice' && (
          <label className="flex flex-col text-sm">
            Current total value (INR)
            <input type="number" step="any" className="mt-1 rounded border px-2 py-1" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} required />
          </label>
        )}

        <div className="sm:col-span-2">
          <button type="submit" disabled={submitting} className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {result && (
        <p className="mt-3 text-sm text-green-700">
          Saved. Position now shows {result.unitsAfter ?? '—'} units, valued at {result.valueAfter ?? '—'}.
          {result.taxClassificationSeeded ? ' Tax classification was seeded for this new security.' : ''}
        </p>
      )}
    </div>
  );
}
