// Net Worth reconciles to the rupee with every Investment Intelligence screen
// (PO decision 2026-10-01 + multi-folio / units-after-statement rules).
//
// The register rows Net Worth counts (investments.current_value, written by the
// re-mark service) must equal what the REAL Holdings table, X-Ray and Overview
// repositories compute from the same ii_* evidence:
//
//   * a fund held in TWO folios, each folio published once: Net Worth = sum of the
//     folios = Holdings = X-Ray = Overview = 222,000 (the multi-folio fixture's
//     portfolio: HDFC Flexi Cap 130,000 over two folios, ICICI 56,000, HDFC Mid-Cap
//     36,000), and the HDFC AMC bucket = 166,000;
//   * units transacted AFTER a folio's certified statement are counted by Net
//     Worth exactly as Holdings counts them (100 units + a 20-unit purchase at NAV
//     140 = 16,800).
//
// NEGATIVE CONTROLS: the same check run against a re-mark that cannot see NAVs
// (the old frozen statement value) or cannot see later transactions must throw its
// named message.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { loadXrayDataset } from '@/lib/services/investment-intelligence/r5Repository';
import { buildOverviewSummary } from '@/lib/services/investment-intelligence/overviewSummary';
import { remarkPublishedInvestments } from '@/lib/services/investment-intelligence/publishedValueRemark';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { makeFilteringClient, type Row } from './support/filteringSupabase';
import { makeFakeDb } from './support/remarkFakeDb';

const USER = 'user-mf';
const TODAY = '2026-09-28';

interface Folio {
  acc: string;
  folio: string;
  stmts: Array<{ date: string; units: number; value: number }>;
  txs: Array<{ id: string; type: string; date: string; amount: number; units: number }>;
}
interface Scheme {
  id: string;
  name: string;
  amc: string;
  isin: string;
  folios: Folio[];
  navs: Array<{ date: string; price: number }>;
}

/** The evidence tables (read by Holdings / X-Ray / Overview AND by the re-mark) + the published register rows. */
function buildAll(schemes: readonly Scheme[]): Record<string, Row[]> {
  const t: Record<string, Row[]> = {
    ii_portfolio_truth_status: [], ii_transactions: [], ii_holding_snapshots: [], ii_instruments: [], ii_accounts: [],
    ii_source_documents: [{ id: 'doc-1', user_id: USER, source_detected: 'cams', status: 'processed' }],
    ii_scheme_master: [], ii_prices_nav: [], investments: [], ii_fhip_publications: [], ii_ownership_allocation: [],
  };
  const seenAcc = new Set<string>();
  for (const s of schemes) {
    t.ii_instruments.push({ id: s.id, instrument_name: s.name, base_currency: 'INR', country_of_domicile: 'IN', isin: s.isin, instrument_class: 'mutual_fund' });
    t.ii_scheme_master.push({ instrument_id: s.id, scheme_name: s.name, amc_name: s.amc, effective_to: null });
    s.navs.forEach((n, i) => t.ii_prices_nav.push({ id: `nav-${s.id}-${i}`, instrument_id: s.id, price_date: n.date, price: n.price, currency_code: 'INR', quality_status: 'ok', data_version: 'v1' }));
    for (const f of s.folios) {
      if (!seenAcc.has(f.acc)) {
        seenAcc.add(f.acc);
        t.ii_accounts.push({ id: f.acc, user_id: USER, folio_number: f.folio, institution_name: s.amc, currency_code: 'INR', owner_member_id: null });
      }
      t.ii_portfolio_truth_status.push({ id: `truth-${f.acc}-${s.id}`, user_id: USER, account_id: f.acc, instrument_id: s.id, status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'doc-1', history_completeness: 'complete_from_inception' });
      for (const x of f.txs) t.ii_transactions.push({ id: x.id, user_id: USER, account_id: f.acc, instrument_id: s.id, transaction_type: x.type, transaction_date: x.date, gross_amount: x.amount, units: x.units, price_per_unit: x.units ? x.amount / x.units : null, source_description: x.type, currency_code: 'INR', status: 'parsed' });
      f.stmts.forEach((st, i) => t.ii_holding_snapshots.push({ id: `snap-${f.acc}-${s.id}-${i}`, user_id: USER, account_id: f.acc, instrument_id: s.id, as_of_date: st.date, units: st.units, value: st.value, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-1' }));
      // Each folio is PUBLISHED ONCE: one register row + one active publication, pointing at its latest certified snapshot.
      const last = f.stmts.length - 1;
      const latest = f.stmts[last];
      const key = `${f.acc}-${s.id}`;
      t.investments.push({ id: `inv-${key}`, user_id: USER, is_active: true, source_type: 'investment_intelligence_published', investment_name: s.name, institution: s.amc, current_value: latest.value, currency_code: 'INR', ii_publication_id: `pub-${key}`, ii_canonical_account_id: f.acc, ii_canonical_instrument_id: s.id, ii_valuation_fingerprint: null });
      t.ii_fhip_publications.push({ id: `pub-${key}`, user_id: USER, published_row_id: `inv-${key}`, canonical_position_id: `snap-${f.acc}-${s.id}-${last}`, account_id: f.acc, instrument_id: s.id, status: 'published', publication_target: 'investments', published_value: latest.value });
    }
  }
  return t;
}

const S1: Scheme = {
  id: 'inst-s1', name: 'HDFC Flexi Cap Fund', amc: 'HDFC Mutual Fund', isin: 'INF179K01XX1',
  folios: [
    { acc: 'acc-a1', folio: '19960529/05', txs: [{ id: 'tx-s1-f1', type: 'purchase', date: '2025-01-10', amount: 60000, units: 600 }], stmts: [{ date: '2026-06-30', units: 600, value: 66000 }] },
    { acc: 'acc-a2', folio: '19960529/05', txs: [{ id: 'tx-s1-f2', type: 'purchase', date: '2025-06-10', amount: 40000, units: 400 }], stmts: [{ date: '2026-08-31', units: 400, value: 48000 }] },
  ],
  navs: [{ date: '2026-06-30', price: 110 }, { date: '2026-08-31', price: 120 }, { date: '2026-09-25', price: 130 }],
};
const S2: Scheme = {
  id: 'inst-s2', name: 'ICICI Prudential Bluechip Fund', amc: 'ICICI Prudential Mutual Fund', isin: 'INF109K01XX2',
  folios: [{ acc: 'acc-b1', folio: '7711/22', txs: [{ id: 'tx-s2', type: 'purchase', date: '2025-03-01', amount: 50000, units: 500 }], stmts: [{ date: '2026-09-20', units: 500, value: 55000 }] }],
  navs: [{ date: '2026-09-20', price: 110 }, { date: '2026-09-25', price: 112 }],
};
const S3: Scheme = {
  id: 'inst-s3', name: 'HDFC Mid-Cap Opportunities Fund', amc: 'HDFC Mutual Fund', isin: 'INF179K01XX3',
  folios: [{ acc: 'acc-a1', folio: '19960529/05', txs: [{ id: 'tx-s3', type: 'purchase', date: '2025-04-01', amount: 30000, units: 300 }], stmts: [{ date: '2026-09-26', units: 300, value: 36000 }] }],
  navs: [{ date: '2026-09-24', price: 118 }],
};
const SU: Scheme = {
  id: 'inst-u', name: 'Alpha Flexi Cap Fund', amc: 'Alpha AMC', isin: 'INF000000001',
  folios: [{ acc: 'acc-u', folio: 'FOLIO-U', txs: [{ id: 'tx-u1', type: 'purchase', date: '2025-01-05', amount: 9500, units: 100 }, { id: 'tx-u2', type: 'purchase', date: '2026-09-10', amount: 2600, units: 20 }], stmts: [{ date: '2026-06-30', units: 100, value: 10000 }] }],
  navs: [{ date: '2026-09-25', price: 140 }],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T10:00:00.000Z`));
});
afterEach(() => {
  vi.useRealTimers();
});

type Blind = 'none' | 'no_nav' | 'no_movements';

/** Runs the re-mark. A "blind" re-mark is the modelled bug: it cannot see NAVs / later transactions. */
async function runRemark(tables: Record<string, Row[]>, blind: Blind = 'none') {
  const view = { ...tables, ...(blind === 'no_nav' ? { ii_prices_nav: [] } : {}), ...(blind === 'no_movements' ? { ii_transactions: [] } : {}) };
  const db = makeFakeDb(view);
  return remarkPublishedInvestments(USER, { client: db.client, trigger: 'manual', asOfDate: TODAY, revisionWriter: async () => ({ error: null }) });
}

const netWorth = (tables: Record<string, Row[]>, institution?: string): number => {
  const investments = tables.investments
    .filter((r) => r.user_id === USER && r.is_active === true && (institution === undefined || r.institution === institution))
    .map((r) => ({ current_value: Number(r.current_value), cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, institution: r.institution as string, currency_code: 'INR' }));
  const input: DashboardInput = { income: [], expenses: [], assets: [], liabilities: [], investments, retirement: [], insurance: [], goals: [], snapshots: [] };
  return computeDashboard(input, 'INR', 56).netWorth;
};

const rule = (msg: string): never => {
  throw new Error(`RULE NW-MF: ${msg}`);
};

describe('two folios of one fund, each published once: Net Worth = Holdings = X-Ray = Overview to the rupee', () => {
  const check = async (blind: Blind) => {
    const tables = buildAll([S1, S2, S3]);
    await runRemark(tables, blind);
    const client = makeFilteringClient(tables) as SupabaseClient;

    const holdings = await loadHoldingsTable(client, USER);
    const holdingsTotal = holdings.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
    const xray = await loadXrayDataset(client, USER);
    const xrayTotal = xray.dataset!.positions.reduce((s, p) => s + p.value, 0);
    const overview = await buildOverviewSummary(client, USER);
    const overviewTotal = overview.portfolio.valueByCurrency[0].totalValue;
    const nw = netWorth(tables);

    if (new Set([nw, holdingsTotal, xrayTotal, overviewTotal]).size !== 1) {
      rule(`Net Worth must equal Holdings, X-Ray and Overview (Net Worth ${nw}, Holdings ${holdingsTotal}, X-Ray ${xrayTotal}, Overview ${overviewTotal})`);
    }
    if (nw !== 222000) rule(`the multi-folio fixture's portfolio is 222000 (got ${nw})`);
    // Per folio: Net Worth's row equals the Holdings row of the same folio.
    for (const h of holdings.holdings) {
      const reg = tables.investments.find((r) => r.ii_canonical_account_id === h.accountId && r.ii_canonical_instrument_id === h.instrumentId)!;
      if (Number(reg.current_value) !== h.marketValue) rule(`folio ${h.accountId}/${h.instrumentId}: Net Worth ${String(reg.current_value)} != Holdings ${h.marketValue}`);
    }
    // The HDFC AMC bucket (Net Worth rows by institution) equals X-Ray's AMC exposure.
    const hdfcNw = netWorth(tables, 'HDFC Mutual Fund');
    if (hdfcNw !== 166000) rule(`the HDFC AMC bucket must be 166000 (got ${hdfcNw})`);
    return { tables, nw, holdings };
  };

  it('real code: 78,000 + 52,000 (two folios of HDFC Flexi Cap) + 56,000 + 36,000 = 222,000 everywhere; HDFC bucket 166,000; one register row per folio', async () => {
    const { tables, holdings } = await check('none');
    expect(tables.investments).toHaveLength(4);
    expect(tables.investments.map((r) => [r.id, r.current_value, r.ii_valuation_basis, r.ii_value_as_of])).toEqual([
      ['inv-acc-a1-inst-s1', 78000, 'market_nav', '2026-09-25'],
      ['inv-acc-a2-inst-s1', 52000, 'market_nav', '2026-09-25'],
      ['inv-acc-b1-inst-s2', 56000, 'market_nav', '2026-09-25'],
      ['inv-acc-a1-inst-s3', 36000, 'statement', '2026-09-26'], // the only NAV (2026-09-24) is OLDER than the statement
    ]);
    expect(holdings.holdings).toHaveLength(4);
  });

  it('NEGATIVE CONTROL: a re-mark that cannot see NAVs (the old frozen statement value) fails the reconciliation with its named message', async () => {
    await expect(check('no_nav')).rejects.toThrow(/RULE NW-MF: Net Worth must equal Holdings, X-Ray and Overview \(Net Worth 205000, Holdings 222000/);
  });
});

describe('units transacted after the certified statement: Net Worth counts them exactly as Holdings does', () => {
  const check = async (blind: Blind) => {
    const tables = buildAll([SU]);
    await runRemark(tables, blind);
    const holdings = await loadHoldingsTable(makeFilteringClient(tables) as SupabaseClient, USER);
    const hv = holdings.holdings[0].marketValue;
    const nw = netWorth(tables);
    if (nw !== hv) rule(`Net Worth must equal Holdings for units added after the statement (Net Worth ${nw}, Holdings ${hv})`);
    if (nw !== 16800) rule(`100 + 20 units at NAV 140 must be 16800 (got ${nw})`);
    return tables.investments[0];
  };

  it('real code: (100 + 20) x 140 = 16,800 in both, with 120 units recorded', async () => {
    const r = await check('none');
    expect(r).toMatchObject({ current_value: 16800, ii_valuation_units: 120, ii_valuation_nav: 140, ii_value_as_of: '2026-09-25', ii_valuation_basis: 'market_nav' });
  });

  it('NEGATIVE CONTROL: a re-mark that ignores later transactions values 14,000 and fails the equality check', async () => {
    await expect(check('no_movements')).rejects.toThrow(/RULE NW-MF: Net Worth must equal Holdings for units added after the statement \(Net Worth 14000, Holdings 16800\)/);
  });

  it('a purchase on the statement date is inside the statement (not counted twice); a future-dated one is ignored', async () => {
    const tables = buildAll([{ ...SU, folios: [{ ...SU.folios[0], txs: [{ id: 'same-day', type: 'purchase', date: '2026-06-30', amount: 1, units: 5 }, { id: 'future', type: 'purchase', date: '2026-10-09', amount: 1, units: 7 }] }] }]);
    await runRemark(tables);
    expect(tables.investments[0]).toMatchObject({ current_value: 14000, ii_valuation_units: 100 });
  });
});
