// Browser entry for scripts/a11y/incomeGridCheck.mjs: the REAL Income page grid (components/grid/FinancialDataGrid.tsx with
// lib/grid/configs.ts incomeGridConfig) in a real browser, with fetch answered from an in-memory fixture. No dev server, no login,
// no database: nothing here can touch DEV or production. Every write the grid makes is recorded on window.__CALLS__ so the check can
// assert what was sent.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { incomeGridConfig, expenseGridConfig } from '@/lib/grid/configs';

const fx = window.__FIXTURE__;

const MASTER = [
  ['employment_salary', 'Employment Salary', 10],
  ['bonus', 'Bonus', 20],
  ['rental_income', 'Rental Income', 30],
  ['dividend_income', 'Dividend Income', 40],
].map(([item_key, item_label, sort_order]) => ({ item_key, item_label, sort_order }));

const base = { owner: 'self', currency_code: 'AUD', is_taxable: true, is_active: true, net_amount: null, tax_amount: null, employer_name: null, notes: null, superseded_by_bank_import: false, source_type: 'manual', last_imported_at: null };
// The PO's own figures (16-10-2026 audit): an annual salary of 196,994.48 imported from a payslip with an entered take-home of 138,386.48.
let income = [
  { ...base, id: 'sal', master_item_key: 'employment_salary', source_name: 'Employment Salary', amount: 196994.48, frequency: 'annually', net_amount: 138386.48, source_type: 'payslip_import', last_imported_at: '2026-10-12T01:00:00.000Z', employer_name: 'Acme Pty Ltd' },
  // A bonus with no take-home and no tax: the gross is assumed to be take-home (amber).
  { ...base, id: 'bon', master_item_key: 'bonus', source_name: 'Bonus', amount: 20000, frequency: 'annually' },
  // Tax entered instead of take-home: 20,000 - 6,000 = 14,000.
  { ...base, id: 'oth', master_item_key: null, source_name: 'Consulting side job', amount: 20000, frequency: 'annually', tax_amount: 6000 },
  // A fortnightly payslip-imported wage whose entered take-home is implausibly small (PO audit symptom).
  { ...base, id: 'fort', master_item_key: null, source_name: 'Casual shifts', amount: 3000, frequency: 'fortnightly', net_amount: 400, source_type: 'payslip_import' },
  { ...base, id: 'rent', master_item_key: 'rental_income', source_name: 'Rental Income', amount: 2000, frequency: 'monthly', net_amount: 1800, currency_code: 'AUD' },
];
if (fx.onlyOne) income = income.filter((r) => r.id === fx.onlyOne);
const expenses = [{ id: 'e1', master_item_key: null, expense_name: 'Gym', amount: 50, frequency: 'monthly', owner: 'self', currency_code: 'AUD', is_essential: false, is_active: true, source_type: 'manual' }];

window.__CALLS__ = [];
const json = (data, status = 200) => new Response(JSON.stringify(status === 200 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') window.__CALLS__.push({ method, url: u, body: init.body ? JSON.parse(init.body) : null });
  if (u.startsWith('/api/capabilities/nav')) return json({ writeDecisions: { INCOME: 'ENABLED', EXPENSES: 'ENABLED' }, deleteDecisions: { INCOME: 'ENABLED', EXPENSES: 'ENABLED' } });
  if (u.startsWith('/api/master-items')) return json(MASTER);
  if (u.startsWith('/api/user/profile')) return json({ preferred_currency: 'AUD', country_of_residence: 'AU' });
  if (u.startsWith('/api/user/section-status')) return json([]);
  if (u === '/api/income' && method === 'GET') return json(income);
  if (u === '/api/expenses' && method === 'GET') return json(expenses);
  const m = u.match(/^\/api\/income\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const body = JSON.parse(init.body);
    income = income.map((r) => (r.id === m[1] ? { ...r, ...body } : r));
    return json(income.find((r) => r.id === m[1]));
  }
  if (u === '/api/income' && method === 'POST') {
    const body = JSON.parse(init.body);
    const existing = body.master_item_key ? income.find((r) => r.master_item_key === body.master_item_key) : null;
    if (existing) {
      income = income.map((r) => (r.id === existing.id ? { ...r, ...body } : r));
      return json(income.find((r) => r.id === existing.id));
    }
    const created = { ...base, id: `new-${income.length}`, ...body };
    income = [...income, created];
    return json(created);
  }
  return json('no fixture for ' + u, 404);
};

function Shell() {
  return (
    <div style={{ background: '#F5F7FA', minHeight: '100vh' }}>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-nav lg:flex" aria-label="Sidebar stand-in" />
      <main className="px-4 py-8 lg:ml-[248px] lg:px-8">
        <div className="mx-auto max-w-[1480px]">
          <div className="space-y-4">
            {fx.spacer ? <div style={{ height: fx.spacer }} aria-hidden="true" /> : null}
            <FinancialDataGrid config={fx.grid === 'expenses' ? expenseGridConfig : incomeGridConfig} moduleKey={fx.grid === 'expenses' ? 'EXPENSES' : 'INCOME'} />
          </div>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Shell />);
