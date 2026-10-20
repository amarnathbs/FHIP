'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EntityFlowPanel } from '@/components/entities/EntityFlowPanel';
import { BankStatementImportPanel } from '@/components/expenses/BankStatementImportPanel';
import { fetchJson, formatMoneySafe } from './format';
import { FREQUENCY_OPTIONS } from '@/lib/engines/money';
import type { SmsfFundRow, SmsfHoldingRow } from './types';

interface LegacyIncome { id: string; source_name: string; amount: number; frequency: string; currency_code: 'AUD' | 'INR' }
interface LegacyExpense { id: string; expense_name: string; amount: number; frequency: string; currency_code: 'AUD' | 'INR'; expense_category: string }
interface MovePreview { status: 'preview' | 'applied'; name?: string; amount?: number; frequency?: string; currency_code?: 'AUD' | 'INR'; income_type?: string; expense_type?: string }

const FREQ_LABEL: Record<string, string> = Object.fromEntries(FREQUENCY_OPTIONS.map((f) => [f.value, f.label.toLowerCase()]));

// The SMSF's OWN income and expenses (PO review 20-10-2026, F22 / F23): entered here, scoped to the fund, never in personal Income or Expenses.
// Also the one place the fund's bank statements are uploaded (Premium, the same Financial Data Hub lifecycle, owner fixed to the fund), and where a
// row entered the earlier way (a personal row tagged SMSF) is moved into the fund so a flow is never recorded twice.
export function SmsfCashFlowSection({ fund, onChanged }: { fund: SmsfFundRow; onChanged?: () => void }) {
  const apiBase = `/api/smsf/${fund.id}`;
  const [properties, setProperties] = useState<{ id: string; name: string }[]>([]);
  const [legacy, setLegacy] = useState<{ income: LegacyIncome[]; expenses: LegacyExpense[] } | null>(null);
  const [move, setMove] = useState<{ register: 'income' | 'expenses'; id: string; preview: MovePreview } | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reloadAround = useCallback(async () => {
    try {
      const [holdings, legacyRows] = await Promise.all([
        fund.mode === 'detailed' ? fetchJson<SmsfHoldingRow[]>(`${apiBase}/holdings`) : Promise.resolve([] as SmsfHoldingRow[]),
        fetchJson<{ income: LegacyIncome[]; expenses: LegacyExpense[] }>(`${apiBase}/legacy-cash-flow`),
      ]);
      setProperties(holdings.filter((h) => h.holding_class === 'property').map((h) => ({ id: h.id, name: h.holding_name })));
      setLegacy(legacyRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this');
    }
  }, [apiBase, fund.mode]);

  useEffect(() => {
    void reloadAround();
  }, [reloadAround, refresh]);

  async function startMove(register: 'income' | 'expenses', id: string) {
    setError(null);
    try {
      const preview = await fetchJson<MovePreview>(`${apiBase}/move-cash-flow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ register, row_id: id, confirm: false }) });
      setMove({ register, id, preview });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check this move');
    }
  }

  async function confirmMove() {
    const target = move;
    setMove(null);
    if (!target) return;
    try {
      await fetchJson(`${apiBase}/move-cash-flow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ register: target.register, row_id: target.id, confirm: true }) });
      setRefresh((n) => n + 1);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move this');
    }
  }

  const legacyCount = (legacy?.income.length ?? 0) + (legacy?.expenses.length ?? 0);

  return (
    <div className="space-y-5" data-testid="smsf-cash-flow-section">
      {legacyCount > 0 && legacy && (
        <div role="note" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-ink" data-testid="smsf-legacy-cash-flow">
          <p className="font-medium">Some of the fund&apos;s income or expenses are still in your personal pages</p>
          <p className="mt-1">
            They are still counted in the fund&apos;s figures. Move each one into the fund so it lives in one place and is never counted twice. Nothing is deleted, the personal record is kept in your history.
          </p>
          <ul className="mt-2 space-y-1">
            {legacy.income.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>Income: {r.source_name} ({formatMoneySafe(r.amount, r.currency_code)} {FREQ_LABEL[r.frequency] ?? r.frequency})</span>
                <button type="button" onClick={() => startMove('income', r.id)} className="rounded border border-line bg-white px-3 py-1 text-xs text-ink hover:bg-gray-50">Move into the fund</button>
              </li>
            ))}
            {legacy.expenses.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>Expense: {r.expense_name} ({formatMoneySafe(r.amount, r.currency_code)} {FREQ_LABEL[r.frequency] ?? r.frequency})</span>
                {r.expense_category === 'debt_repayment' ? (
                  <span className="text-xs text-muted">A loan repayment: add the loan under Liabilities instead</span>
                ) : (
                  <button type="button" onClick={() => startMove('expenses', r.id)} className="rounded border border-line bg-white px-3 py-1 text-xs text-ink hover:bg-gray-50">Move into the fund</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <EntityFlowPanel
        key={`income-${refresh}`}
        flow="income"
        apiBase={apiBase}
        currency={fund.currency_code}
        assetLinkField="smsf_holding_id"
        assetOptions={properties}
        onChanged={onChanged}
      />
      <EntityFlowPanel key={`expenses-${refresh}`} flow="expenses" apiBase={apiBase} currency={fund.currency_code} onChanged={onChanged} />

      <section aria-label="Fund bank statements" data-testid="smsf-bank-statements">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Bank statements of the fund</h4>
          {!showUpload && (
            <button type="button" onClick={() => setShowUpload(true)} className="text-sm font-medium text-trust hover:underline">Upload a bank statement</button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          Premium. Upload the fund&apos;s bank statement and review it like any other statement. Approved transactions appear as the fund&apos;s actual income and spending in its reports and cash flow, and never in your household spending.
        </p>
        {showUpload && (
          <div className="mt-3">
            <BankStatementImportPanel fixedOwner={{ kind: 'smsf' }} onClose={() => { setShowUpload(false); onChanged?.(); }} />
          </div>
        )}
      </section>

      {error && <p role="alert" className="text-sm text-risk">{error}</p>}

      <ConfirmDialog
        open={move !== null}
        title="Move this into the fund?"
        message={`"${move?.preview.name ?? ''}" (${formatMoneySafe(move?.preview.amount ?? null, move?.preview.currency_code ?? 'AUD')} ${FREQ_LABEL[move?.preview.frequency ?? ''] ?? ''}) becomes a record of the fund and leaves your personal ${move?.register === 'income' ? 'Income' : 'Expenses'}. It is counted once. It is kept in your history.`}
        confirmLabel="Move into the fund"
        destructive={false}
        onConfirm={confirmMove}
        onCancel={() => setMove(null)}
      />
    </div>
  );
}
