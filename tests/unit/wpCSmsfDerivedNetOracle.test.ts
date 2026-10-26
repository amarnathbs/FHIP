// DOCUMENT2 (4) review, WP-C, F19 and F20 (PO, 20-10-2026): for an itemised SMSF the fund's net is DERIVED from its assets and liabilities and the
// SAME number is read by every consumer; there is no second editable balance and no "Difference" concept in normal Detailed mode.
// EVIDENCE LABEL: UNIT-TESTED (hand oracles). The database half (derived net, Retirement mirror) is PGLITE-VERIFIED in wpCEntityFinancePglite.test.ts
// against the same constants below. Not DEV- or production-verified.
//
// HAND ORACLE (AUD, the PO household): assets 475,000 + 3,000 + 25,000 = 503,000; fund liability 370,000; derived net 133,000;
// personal net worth 874,441; family net worth 874,441 + 133,000 = 1,007,441.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInMemoryDb } from './support/inMemorySupabase';
import { loadSmsfBalanceSheets } from '@/lib/services/entityBalanceSheetData';
import { computeNetWorthLevels, type NetWorthRowInput } from '@/lib/engines/netWorthLevels';
import { loadSmsfFundReportBundle } from '@/lib/services/smsfReportData';
import { buildSmsfAccountantExportCsv } from '@/lib/services/smsfExport';
import { australianFinancialYearFor } from '@/lib/engines/smsf/smsfReportingPeriod';
import { userVisibleFundNotes } from '@/lib/engines/smsf/smsfNotes';
import type { CanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';

const ROOT = path.resolve(__dirname, '..', '..');
const U = 'user-1';
const NET = 133_000;

const tables = () => ({
  smsf_funds: [{ id: 'f1', user_id: U, fund_name: 'PO SMSF', mode: 'detailed', summary_balance: null, currency_code: 'AUD', retirement_account_id: 'ra1', is_active: true, detailed_net_value: NET }],
  smsf_holdings: [
    { id: 'h1', user_id: U, smsf_fund_id: 'f1', holding_name: '250 Elizebth st', holding_type: 'residential_property', value: 475_000, currency_code: 'AUD', is_active: true },
    { id: 'h2', user_id: U, smsf_fund_id: 'f1', holding_name: 'Bank Australia', holding_type: 'cash_account', value: 3_000, currency_code: 'AUD', is_active: true },
    { id: 'h3', user_id: U, smsf_fund_id: 'f1', holding_name: 'Secured finance', holding_type: 'cash_account', value: 25_000, currency_code: 'AUD', is_active: true },
  ],
  smsf_liabilities: [{ id: 'l1', user_id: U, smsf_fund_id: 'f1', liability_name: 'SMSF property loan', liability_type: 'property_loan', lender: null, balance: 370_000, interest_rate: 6.2, monthly_repayment: 2_400, currency_code: 'AUD', is_active: true }],
  smsf_fund_members: [],
  property_liability_links: [],
  income_sources: [],
  entity_income_items: [],
  entity_expense_items: [],
  expense_items: [],
  retirement_accounts: [{ id: 'ra1', user_id: U, employer_contribution: null, personal_contribution: null, contribution_frequency: null }],
});

const snapshot = { status: 'ok', fx: { reportingCurrency: 'AUD', fxRateAudInr: 56 }, liabilities: { status: 'ok', lines: [] } } as unknown as CanonicalFinancialSnapshot;

const R = (r: Partial<NetWorthRowInput> & Pick<NetWorthRowInput, 'id' | 'register' | 'owner' | 'amountReporting'>): NetWorthRowInput => ({ name: r.id, currencyCode: 'AUD', ...r });
const PERSONAL: NetWorthRowInput[] = [
  R({ id: 'assets', register: 'assets', owner: 'self', amountReporting: 1_670_298 }),
  R({ id: 'inv', register: 'investments', owner: 'self', amountReporting: 590_000 }),
  R({ id: 'home', register: 'liabilities', owner: 'self', amountReporting: 600_000 }),
  R({ id: 'inv-loan', register: 'liabilities', owner: 'joint', amountReporting: 700_000 }),
  R({ id: 'car', register: 'liabilities', owner: 'spouse', amountReporting: 85_857 }),
];

/** The in-memory fake plus the one RPC the report bundle calls; every call is recorded so a test can name which function was read. */
function clientWithRpc(t: Record<string, Record<string, unknown>[]>) {
  const db = createInMemoryDb();
  db.reset(t);
  const rpcCalls: string[] = [];
  const client = {
    from: (table: string) => (db.client as { from: (x: string) => unknown }).from(table),
    rpc: async (name: string) => {
      rpcCalls.push(name);
      if (name === 'smsf_fund_counted_net') return { data: NET, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  };
  return { client: client as unknown as SupabaseClient, rpcCalls };
}

describe('F19: one derived value, read by every consumer', () => {
  it('the family-view loader derives 133,000 from the lines', async () => {
    const { client } = clientWithRpc(tables());
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase: client, snapshot });
    expect(sheets![0]).toMatchObject({ mode: 'itemised', assetsTotal: 503_000, liabilitiesTotal: 370_000, net: NET });
  });

  it('the Dashboard family block, entity row and family net worth carry the same 133,000 (family 1,007,441)', async () => {
    const { client } = clientWithRpc(tables());
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase: client, snapshot });
    const l = computeNetWorthLevels({ currency: 'AUD', rows: [...PERSONAL, R({ id: 'fund', register: 'retirement', owner: 'self', masterItemKey: 'smsf', amountReporting: NET })], entitySheets: sheets! });
    const smsf = l.entities.blocks.find((b) => b.kind === 'smsf')!;
    expect(smsf.entityTotals.totalAssets).toBe(503_000);
    expect(smsf.entityTotals.liabilities).toBe(370_000);
    expect(smsf.included.net).toBe(NET);
    expect(l.personal.total.net).toBe(874_441);
    expect(l.family.net).toBe(1_007_441);
  });

  it('the SMSF report reads the counted net from ONE database function and carries no second figure', async () => {
    const { client, rpcCalls } = clientWithRpc(tables());
    const { data: bundle, error } = await loadSmsfFundReportBundle('f1', U, client);
    expect(error).toBeNull();
    expect(bundle!.position).toEqual({ mode: 'itemised', net: NET });
    expect(rpcCalls).toEqual(['smsf_fund_counted_net']);
    expect(Object.keys(bundle!)).not.toContain('reconciliation');
  });

  it('the CSV export carries the same net, in words, and none of the old difference vocabulary', async () => {
    const { client } = clientWithRpc(tables());
    const { data: bundle } = await loadSmsfFundReportBundle('f1', U, client);
    const csv = buildSmsfAccountantExportCsv(bundle!, australianFinancialYearFor(new Date(Date.UTC(2026, 9, 20))));
    expect(csv).toContain('Net - assets less liabilities (worked out by FHIP),133000');
    for (const word of ['Reconciliation', 'Variance', 'Summary balance', 'Difference']) expect(csv).not.toContain(word);
  });

  it('NEGATIVE CONTROL: a leftover typed 138,000 on the itemised fund changes none of the consumers', async () => {
    const t = tables();
    (t.smsf_funds[0] as Record<string, unknown>).summary_balance = 138_000;
    const { client } = clientWithRpc(t);
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase: client, snapshot });
    expect(sheets![0].net).toBe(NET);
    expect(sheets![0].typedNet).toBeNull();
    const l = computeNetWorthLevels({ currency: 'AUD', rows: PERSONAL, entitySheets: sheets! });
    expect(l.family.net).toBe(1_007_441);
  });

  it('NEGATIVE CONTROL (it can fail): a net-only fund of 138,000 DOES change the figure, so the oracle is not vacuous', async () => {
    const t = tables();
    Object.assign(t.smsf_funds[0], { mode: 'summary', summary_balance: 138_000 });
    const { client } = clientWithRpc(t);
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase: client, snapshot });
    expect(sheets![0].net).toBe(138_000);
    expect(sheets![0].net).not.toBe(NET);
  });
});

describe('F20: no "Difference" / reconciliation concept and no technical migration copy in normal Detailed mode', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const SCREENS = ['components/retirement/smsf/SmsfReportsPanel.tsx', 'components/retirement/smsf/SmsfDetailedWorkspace.tsx', 'components/retirement/smsf/SmsfFundCard.tsx', 'components/retirement/smsf/SmsfNetPosition.tsx'];

  it.each(SCREENS)('%s shows no Difference, Reconciliation, Summary balance or Variance wording', (rel) => {
    const src = read(rel).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const word of ['Difference', 'Reconciliation', 'Summary balance', 'Summary Value', 'Variance']) expect(src).not.toContain(word);
  });

  it('the report API bundle and the export no longer have a reconciliation field', () => {
    const src = read('lib/services/smsfReportData.ts') + read('lib/services/smsfExport.ts');
    expect(src).not.toMatch(/reconciliation\s*:/);
    expect(src).not.toMatch(/summaryBalance|detailedNetValue/);
  });

  it('system-authored migration notes are never shown to the user, a note the user wrote still is', () => {
    expect(userVisibleFundNotes('Backfilled by migration 0084 from the pre-existing retirement_accounts row (Summary Mode, value unchanged).')).toBeNull();
    expect(userVisibleFundNotes('  ')).toBeNull();
    expect(userVisibleFundNotes(null)).toBeNull();
    expect(userVisibleFundNotes('Held at Bank Australia')).toBe('Held at Bank Australia');
  });

  it('the fund card renders notes only through the filter', () => {
    const src = read('components/retirement/smsf/SmsfFundCard.tsx');
    expect(src).toContain('userVisibleFundNotes(fund.notes)');
    expect(src).not.toMatch(/\{fund\.notes\}/);
  });
});
