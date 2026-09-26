'use client';

/**
 * WP-08 (EXP-G5): split one transaction into parts -- e.g. a $100 card
 * payment that was $80 groceries and $20 moved to savings. Posts to the
 * existing split route, which replaces the whole split atomically (migration
 * 0212) and refuses an approved transaction (reopen its statement first) and
 * any part without a type. The parts must add up to the transaction exactly;
 * the server re-checks, this form only helps.
 */

import { useState } from 'react';

// The closed FDH economic types, minus 'unknown' (a part must say what the
// money was). Kept as a literal list: the enums module is server-side.
const PART_TYPES: Array<{ value: string; label: string }> = [
  { value: 'expense', label: 'Spending' },
  { value: 'fee', label: 'Fee' },
  { value: 'tax', label: 'Tax' },
  { value: 'debt_interest', label: 'Interest' },
  { value: 'income', label: 'Income' },
  { value: 'refund', label: 'Refund' },
  { value: 'transfer', label: 'Transfer between your accounts' },
  { value: 'investment', label: 'Investment' },
  { value: 'debt_principal', label: 'Loan repayment (principal)' },
  { value: 'asset_purchase', label: 'Asset purchase' },
  { value: 'asset_sale', label: 'Asset sale' },
  { value: 'cash_withdrawal', label: 'Cash withdrawal' },
];

interface Part {
  type: string;
  categoryId: string;
  amount: string;
}

const toCents = (v: string | number): number => Math.round(Number(v) * 100);

export function SplitTransactionEditor({
  transactionId,
  amount,
  currency,
  categories,
  disabled,
  onSave,
}: {
  transactionId: string;
  amount: number;
  currency: string;
  categories: Array<{ id: string; label: string; economicType: string }>;
  disabled: boolean;
  onSave: (label: string, action: () => Promise<unknown>) => void;
}) {
  const [parts, setParts] = useState<Part[]>([
    { type: 'expense', categoryId: '', amount: '' },
    { type: 'transfer', categoryId: '', amount: '' },
  ]);
  const allocated = parts.reduce((s, p) => s + (Number.isFinite(Number(p.amount)) ? toCents(p.amount) : 0), 0);
  const remaining = toCents(amount) - allocated;
  const valid = parts.length >= 2 && parts.every((p) => p.type && Number(p.amount) > 0) && remaining === 0;

  function update(i: number, patch: Partial<Part>) {
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  function save() {
    onSave('Split saved.', async () => {
      const res = await fetch(`/api/financial-data-hub/bank-transactions/${encodeURIComponent(transactionId)}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          finalize: true,
          allocations: parts.map((p) => ({
            economic_transaction_type: p.type,
            category_id: p.categoryId || null,
            amount: Number(p.amount),
          })),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? 'We could not save this split.');
      return json?.data;
    });
  }

  return (
    <div className="rounded-compact border border-line bg-white p-4">
      <h3 className="text-sm font-semibold text-ink">Split this transaction</h3>
      <p className="mt-1 text-xs text-muted">
        Use this when one line on your statement was really several things. The parts must add up to {amount.toFixed(2)} {currency}. Each part is
        counted as its own type; the line itself is not counted twice.
      </p>
      <ul className="mt-3 space-y-2">
        {parts.map((p, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-muted">
              Part {i + 1} type
              <select value={p.type} onChange={(e) => update(i, { type: e.target.value, categoryId: '' })} className="mt-1 rounded-compact border border-line bg-white px-2 py-1 text-sm text-ink">
                {PART_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs text-muted">
              Part {i + 1} category (optional)
              <select value={p.categoryId} onChange={(e) => update(i, { categoryId: e.target.value })} className="mt-1 rounded-compact border border-line bg-white px-2 py-1 text-sm text-ink">
                <option value="">No category</option>
                {categories.filter((c) => c.economicType === p.type).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs text-muted">
              Part {i + 1} amount
              <input inputMode="decimal" value={p.amount} onChange={(e) => update(i, { amount: e.target.value })} className="mt-1 w-28 rounded-compact border border-line px-2 py-1 text-sm text-ink" />
            </label>
            {parts.length > 2 && (
              <button type="button" onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))} className="text-xs text-muted underline">
                Remove part {i + 1}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {parts.length < 10 && (
          <button type="button" onClick={() => setParts((ps) => [...ps, { type: 'expense', categoryId: '', amount: '' }])} className="text-sm text-trust underline">
            Add a part
          </button>
        )}
        <p role="status" className={remaining === 0 ? 'text-xs text-positive' : 'text-xs text-muted'}>
          {remaining === 0 ? 'The parts add up.' : `${(Math.abs(remaining) / 100).toFixed(2)} ${currency} ${remaining > 0 ? 'still to split' : 'too much'}`}
        </p>
        <button type="button" disabled={disabled || !valid} onClick={save} className="rounded-compact border border-trust px-3 py-1.5 text-sm font-semibold text-trust disabled:opacity-50">
          Save split
        </button>
      </div>
    </div>
  );
}
