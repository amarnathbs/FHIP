// The loader that builds the SMSF balance sheet for the family view (lib/services/entityBalanceSheetData.ts), against an in-memory PostgREST fake that
// applies the filters for real (a query that forgets user_id or is_active returns the wrong rows here too). EVIDENCE LABEL: UNIT-TESTED.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInMemoryDb } from './support/inMemorySupabase';
import { loadSmsfBalanceSheets } from '@/lib/services/entityBalanceSheetData';
import type { CanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';

const U = 'user-1';
const OTHER = 'user-2';

function snapshot(over: { rate?: number; linked?: { id: string; name: string; balance: number }[] } = {}): CanonicalFinancialSnapshot {
  return {
    status: 'ok',
    fx: { reportingCurrency: 'AUD', fxRateAudInr: over.rate ?? 56 },
    liabilities: {
      status: 'ok',
      lines: (over.linked ?? []).map((l) => ({ id: l.id, name: l.name, balance: { amountNative: l.balance, currency: 'AUD', amountReporting: l.balance } })),
    },
  } as unknown as CanonicalFinancialSnapshot;
}

const FUND = { id: 'f1', user_id: U, fund_name: 'PO SMSF', mode: 'detailed', summary_balance: null, currency_code: 'AUD', retirement_account_id: 'ra1', is_active: true };
const holding = (id: string, value: number, extra: Record<string, unknown> = {}) => ({ id, user_id: U, smsf_fund_id: 'f1', holding_name: id, holding_type: 'cash_account', value, currency_code: 'AUD', is_active: true, ...extra });

function client(tables: Record<string, Record<string, unknown>[]>) {
  const db = createInMemoryDb();
  db.reset(tables);
  return db.client as unknown as SupabaseClient;
}

describe('loadSmsfBalanceSheets', () => {
  it('PO fund: holdings 475,000 + 3,000 + 25,000 less the fund liability 370,000 = net 133,000', async () => {
    const supabase = client({
      smsf_funds: [FUND],
      smsf_holdings: [holding('h1', 475_000), holding('h2', 3_000), holding('h3', 25_000)],
      smsf_liabilities: [{ id: 'l1', user_id: U, smsf_fund_id: 'f1', liability_name: 'SMSF property loan', liability_type: 'property_loan', lender: null, balance: 370_000, currency_code: 'AUD', is_active: true }],
      property_liability_links: [],
    });
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase, snapshot: snapshot() });
    expect(sheets).toHaveLength(1);
    expect(sheets![0]).toMatchObject({ mode: 'itemised', assetsTotal: 503_000, liabilitiesTotal: 370_000, net: 133_000, retirementRowId: 'ra1' });
  });

  it('ignores inactive lines, and another household\'s lines (user_id filter)', async () => {
    const supabase = client({
      smsf_funds: [FUND, { ...FUND, id: 'f2', user_id: OTHER, retirement_account_id: 'ra2' }],
      smsf_holdings: [holding('h1', 100), holding('gone', 999, { is_active: false }), holding('theirs', 777, { user_id: OTHER, smsf_fund_id: 'f2' })],
      smsf_liabilities: [],
      property_liability_links: [],
    });
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase, snapshot: snapshot() });
    expect(sheets).toHaveLength(1);
    expect(sheets![0].assetsTotal).toBe(100);
  });

  it('converts an INR holding once at the household rate (5,600 INR at 56 = 100 AUD) and counts an unconvertible currency instead of zeroing it', async () => {
    const supabase = client({
      smsf_funds: [FUND],
      smsf_holdings: [holding('h1', 1_000), holding('inr', 5_600, { currency_code: 'INR' }), holding('gbp', 50, { currency_code: 'GBP' })],
      smsf_liabilities: [],
      property_liability_links: [],
    });
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase, snapshot: snapshot({ rate: 56 }) });
    expect(sheets![0].assetsTotal).toBe(1_100);
    expect(sheets![0].unconvertedCount).toBe(1);
  });

  it('a personal loan still linked to the fund joins the fund liabilities once (503,000 - 370,000 = 133,000)', async () => {
    const supabase = client({
      smsf_funds: [FUND],
      smsf_holdings: [holding('h1', 503_000)],
      smsf_liabilities: [],
      property_liability_links: [{ liability_id: 'p1', user_id: U, linked_retirement_id: 'ra1', link_type: 'smsf_property_loan', is_active: true }],
    });
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase, snapshot: snapshot({ linked: [{ id: 'p1', name: 'SMSF property loan', balance: 370_000 }] }) });
    expect(sheets![0].liabilities.map((l) => l.origin)).toEqual(['linked_personal_loan']);
    expect(sheets![0].net).toBe(133_000);
  });

  it('a net-value-only fund reads the typed net and ignores stray lines', async () => {
    const supabase = client({
      smsf_funds: [{ ...FUND, mode: 'summary', summary_balance: 133_000 }],
      smsf_holdings: [holding('stray', 9_999)],
      smsf_liabilities: [],
      property_liability_links: [],
    });
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase, snapshot: snapshot() });
    expect(sheets![0]).toMatchObject({ mode: 'net_only', net: 133_000, typedNet: 133_000 });
    expect(sheets![0].assets).toEqual([]);
  });

  it('an entity-free household has no sheet at all', async () => {
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase: client({ smsf_funds: [], smsf_holdings: [], smsf_liabilities: [], property_liability_links: [] }), snapshot: snapshot() });
    expect(sheets).toEqual([]);
  });

  it('a failed read returns null (the caller falls back and says so), never an empty list that would read as no fund', async () => {
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'in']) chain[m] = () => chain;
        chain.range = async () => ({ data: null, error: { message: 'down' } });
        return chain;
      },
    } as unknown as SupabaseClient;
    const { sheets } = await loadSmsfBalanceSheets({ userId: U, supabase: failing, snapshot: snapshot() });
    expect(sheets).toBeNull();
  });
});
