// India MF Investment Report — loader gating, tenancy, section builder, NAV pin,
// print/CSS contract and rendering. Uses an in-memory Supabase double so the
// loader's own user_id scoping is observable.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeSupabase } from '../fixtures/fakeSupabase';
import { syntheticIndiaMfInput } from '../fixtures/indiaMfSynthetic';
import { loadIndiaMfReportForReport } from '@/lib/services/investment-intelligence/indiaMfReportData';
import { buildIndiaMfInvestmentReport } from '@/lib/engines/reportSectionsPremium';
import { buildIndiaMfReport } from '@/lib/engines/investment-intelligence/indiaMfReport';
import { IndiaMfInvestmentReportSection } from '@/components/reports/IndiaMfInvestmentReportSection';
import { deriveReportNavDependencyInputs } from '@/lib/services/investment-intelligence/pc6/reportNavDependencyWriter';
import type { ReportSourceData, PremiumSourceData } from '@/lib/services/reportSnapshotResolver';

const V = '2026-09-30';
const ROOT = path.resolve(__dirname, '..', '..');

type TableSet = Record<string, Array<Record<string, unknown>>>;

function tablesFor(u: string): TableSet {
  return {
    ii_accounts: [{ id: `${u}-acc-in`, user_id: u, folio_number: `${u}-F1`, owner_member_id: `${u}-m1`, currency_code: 'INR', country_code: 'IN', institution_name: 'CAMS' }],
    ii_transactions: [
      { id: `${u}-t1`, user_id: u, account_id: `${u}-acc-in`, instrument_id: 'fund-1', transaction_type: 'purchase', transaction_date: '2024-01-02', units: 100, price_per_unit: 100, gross_amount: 10000, status: 'parsed', source_reference: null },
    ],
    ii_holding_snapshots: [],
    ii_portfolio_truth_status: [],
    ii_ownership_allocation: [],
    household_members: [{ id: `${u}-m1`, user_id: u, full_name: `${u} person`, relationship: 'self' }],
    business_entities: [],
  };
}
const SHARED: TableSet = {
  ii_instruments: [{ id: 'fund-1', instrument_name: 'Sample Fund', isin: null, instrument_class: 'mutual_fund' }],
  ii_scheme_master: [],
  ii_prices_nav: [{ instrument_id: 'fund-1', price_date: '2026-09-29', price: 150, quality_status: 'ok' }],
  ii_benchmarks: [
    { id: 'b-n', benchmark_key: 'IN_NIFTY_50_PRI' },
    { id: 'b-s', benchmark_key: 'IN_SENSEX_PRI' },
  ],
  ii_benchmark_series: [
    { benchmark_id: 'b-n', series_date: '2026-09-29', value: 25700.5, quality_status: 'ok' },
    { benchmark_id: 'b-s', series_date: '2026-09-29', value: 83900.1, quality_status: 'ok' },
  ],
  user_profiles: [{ user_id: 'user-A', country_of_residence: 'AU' }],
};

// The header index closes are entitlement-gated (customer display + report export); these fixtures model an
// approved entitlement for both price-index series so the loader tests below exercise the entitled path.
const ENTITLED_RPC = (name: string, args: Record<string, unknown>) =>
  name === 'benchmark_entitled_actions'
    ? { data: (args.p_benchmark_ids as string[]).map((id) => ({ benchmark_id: id, can_calculate: true, can_display: true, can_export: true, data_from: null, data_to: null })), error: null }
    : { data: null, error: null };

describe('loader gating: India mutual-fund holdings, not home country', () => {
  it('an Australian-resident user with an INR mutual-fund folio gets the section', async () => {
    const { client, calls } = fakeSupabase({ ...SHARED, ...tablesFor('user-A') }, { rpc: ENTITLED_RPC });
    const out = await loadIndiaMfReportForReport('user-A', client, V);
    expect(out?.status).toBe('ok');
    if (out?.status === 'ok') {
      expect(out.report.sections[0].rows[0].schemeName).toBe('Sample Fund');
      expect(out.report.indices.nifty).toMatchObject({ status: 'ok', value: 25700.5 });
    }
    // Home country is never consulted.
    expect(calls.some((c) => c.table === 'user_profiles')).toBe(false);
  });

  it('a user with no INR account at all (e.g. an AU-only household) gets no section: null, not "unavailable"', async () => {
    const t = { ...SHARED, ...tablesFor('user-A') };
    t.ii_accounts = [{ ...t.ii_accounts[0], currency_code: 'AUD', country_code: 'AU' }];
    const { client } = fakeSupabase(t);
    expect(await loadIndiaMfReportForReport('user-A', client, V)).toBeNull();
  });

  it('a user whose INR account holds no mutual fund (equity only) gets no section', async () => {
    const t = { ...SHARED, ...tablesFor('user-A') };
    t.ii_instruments = [{ id: 'fund-1', instrument_name: 'Some Share', isin: null, instrument_class: 'equity' }];
    const { client } = fakeSupabase(t);
    expect(await loadIndiaMfReportForReport('user-A', client, V)).toBeNull();
  });

  it('with no rows at all the answer is null', async () => {
    const { client } = fakeSupabase({});
    expect(await loadIndiaMfReportForReport('user-A', client, V)).toBeNull();
  });
});

describe('cross-user isolation', () => {
  it("another user's rows are never read into this user's report, and every user-scoped read carries user_id = caller", async () => {
    const a = tablesFor('user-A');
    const b = tablesFor('user-B');
    const merged: TableSet = { ...SHARED };
    for (const k of Object.keys(a)) merged[k] = [...a[k], ...b[k]];
    const { client, calls } = fakeSupabase(merged, { rpc: ENTITLED_RPC });
    const out = await loadIndiaMfReportForReport('user-A', client, V);
    expect(out?.status).toBe('ok');
    if (out?.status !== 'ok') return;
    expect(out.report.sections.map((s) => s.label)).toEqual(['user-A person']);
    expect(JSON.stringify(out.report)).not.toContain('user-B');
    for (const table of Object.keys(a)) {
      const reads = calls.filter((c) => c.table === table);
      expect(reads.length, `${table} was read`).toBeGreaterThan(0);
      for (const r of reads) expect(r.eq, `${table} read must be scoped by user_id`).toContainEqual(['user_id', 'user-A']);
    }
  });
});

describe('fail closed', () => {
  it('a read failure AFTER the user is known to hold India funds is an explicit error state, never a partial table', async () => {
    const { client } = fakeSupabase({ ...SHARED, ...tablesFor('user-A') }, { failTable: 'ii_transactions', rpc: ENTITLED_RPC });
    const out = await loadIndiaMfReportForReport('user-A', client, V);
    expect(out?.status).toBe('error');
  });
  it('a failure before the gate (cannot tell whether the user holds India funds) shows nothing', async () => {
    const { client } = fakeSupabase({ ...SHARED, ...tablesFor('user-A') }, { failTable: 'ii_accounts' });
    expect(await loadIndiaMfReportForReport('user-A', client, V)).toBeNull();
  });
});

describe('section builder', () => {
  const stubSource = {} as ReportSourceData;
  const premium = (indiaMf: PremiumSourceData['indiaMf']) => ({ indiaMf }) as PremiumSourceData;

  it('no India MF data: the section is not built at all (null), so it cannot be listed or shown', () => {
    expect(buildIndiaMfInvestmentReport(stubSource, premium(null))).toBeNull();
    expect(buildIndiaMfInvestmentReport(stubSource, premium(undefined))).toBeNull();
  });
  it('error state: an "unavailable" section with the honest reason and no data', () => {
    const s = buildIndiaMfInvestmentReport(stubSource, premium({ status: 'error', message: 'x' }))!;
    expect(s.sectionStatus).toBe('unavailable');
    expect(s.sectionData).toEqual({});
    expect(s.limitationText).toMatch(/No partial table/);
  });
  it('included: carries the pure module result verbatim, observation-only wording, and index dates in source references', () => {
    const report = buildIndiaMfReport(syntheticIndiaMfInput())!;
    const s = buildIndiaMfInvestmentReport(stubSource, premium({ status: 'ok', report }))!;
    expect(s.sectionCode).toBe('india_mf_investment_report');
    expect(s.sectionStatus).toBe('included');
    expect((s.sectionData as { report: unknown }).report).toBe(report);
    expect(s.limitationText).toMatch(/not personal financial or tax advice/);
    expect(s.sourceReferences).toMatchObject({ module: 'india-mf-investment-report', valuationDate: V, sensexDate: V, niftyDate: V });
    // observation-only: no action language in the narrative
    expect(s.narrativeText).not.toMatch(/\b(should|recommend|consider|we suggest)\b/i);
  });
  it('is registered only in the premium builder, which runs only for a premium report', () => {
    const premiumSrc = fs.readFileSync(path.join(ROOT, 'lib/engines/reportSectionsPremium.ts'), 'utf8');
    expect(premiumSrc).toMatch(/buildIndiaMfInvestmentReport\(source, premium\),\s*\r?\n\s*\]\.filter/);
    const sections = fs.readFileSync(path.join(ROOT, 'lib/engines/reportSections.ts'), 'utf8');
    expect(sections).toMatch(/source\.planTier === 'premium' \? \[\.\.\.freeSections, \.\.\.buildPremiumSections/);
    expect(sections).not.toMatch(/buildIndiaMfInvestmentReport/);
    const elig = fs.readFileSync(path.join(ROOT, 'lib/engines/reportEligibility.ts'), 'utf8');
    expect(elig).toMatch(/'india_mf_investment_report'/);
  });
});

describe('NAV pinning', () => {
  it('registers every fund of the section (basis xirr_since_inception, bounded at its earliest transaction)', () => {
    const report = buildIndiaMfReport(syntheticIndiaMfInput())!;
    const inputs = deriveReportNavDependencyInputs({ indiaMf: { status: 'ok', report } } as unknown as PremiumSourceData, V);
    const ids = inputs.map((i) => i.instrumentId).sort();
    expect(ids).toEqual(['i-debt', 'i-flexi', 'i-index', 'i-small']);
    expect(inputs.every((i) => i.basis === 'xirr_since_inception')).toBe(true);
    expect(inputs.find((i) => i.instrumentId === 'i-index')!.earliestTransactionDate).toBe('2020-07-20');
    expect(inputs.find((i) => i.instrumentId === 'i-flexi')!.earliestTransactionDate).toBe('2021-04-05');
  });
  it('an error or absent section registers nothing', () => {
    expect(deriveReportNavDependencyInputs({ indiaMf: { status: 'error', message: 'x' } } as unknown as PremiumSourceData, V)).toEqual([]);
    expect(deriveReportNavDependencyInputs({ indiaMf: null } as unknown as PremiumSourceData, V)).toEqual([]);
  });
  it('when R4 already pins the same (instrument, basis) the WIDER window wins, in either order', () => {
    const report = buildIndiaMfReport(syntheticIndiaMfInput())!;
    const perf = (date: string) => ({ results: { schemes: [{ instrumentId: 'i-flexi' }] }, earliestCashFlowDateByInstrument: { 'i-flexi': date } });
    const early = deriveReportNavDependencyInputs({ investmentPerformance: perf('2019-01-01'), indiaMf: { status: 'ok', report } } as unknown as PremiumSourceData, V);
    expect(early.find((i) => i.instrumentId === 'i-flexi' && i.basis === 'xirr_since_inception')!.earliestTransactionDate).toBe('2019-01-01');
    const late = deriveReportNavDependencyInputs({ investmentPerformance: perf('2023-01-01'), indiaMf: { status: 'ok', report } } as unknown as PremiumSourceData, V);
    expect(late.find((i) => i.instrumentId === 'i-flexi' && i.basis === 'xirr_since_inception')!.earliestTransactionDate).toBe('2021-04-05');
  });
});

describe('rendering and print contract', () => {
  const report = buildIndiaMfReport(syntheticIndiaMfInput())!;
  const html = renderToStaticMarkup(React.createElement(IndiaMfInvestmentReportSection, { report, title: 'Mutual Fund Investment Report', narrative: 'n', limitation: 'l' }));

  it('renders the header, every owner section, tiles, the sixteen sample columns and the total row', () => {
    expect(html).toContain('Valuation Date');
    expect(html).toContain('Report Date');
    expect(html).toContain('BSE Sensex');
    expect(html).toContain('Nifty 50');
    for (const col of ['Folio', 'Scheme', 'Start Dt', 'Units', 'Avg NAV', 'Latest NAV', 'Inv Amt', 'Switch In Amt', 'Red/SWP Amt', 'Switch Out Amt', 'Dividend', 'Avg Days', 'Curr Value', 'Unrealised Gain', 'Realised Gain', 'XIRR']) {
      expect(html).toContain(`>${col}</th>`);
    }
    expect(html.match(/Fund Portfolio Total/g)!.length).toBe(report.sections.length);
    expect(html).toContain('Asha Rao');
    expect(html).toContain('Rao Family HUF');
    expect(html).toContain('Unallocated / owner not set');
    expect(html).toContain('not added together');
  });
  it('shows the visible partial-history marker and the CAS guidance', () => {
    // The marker's date is the row's Start Dt (first recorded acquisition, 14-08-2023), not the opening-balance date.
    expect(html).toContain('from 14-08-2023; earlier history not uploaded');
    expect(html).not.toContain('from 01-04-2023');
    expect(html).toContain('MFCentral integration is available');
  });
  it('index slots say "not available" honestly when no close is loaded', () => {
    const noIdx = buildIndiaMfReport({ ...syntheticIndiaMfInput(), sensex: null, nifty: null })!;
    const out = renderToStaticMarkup(React.createElement(IndiaMfInvestmentReportSection, { report: noIdx, title: 't', narrative: null, limitation: null }));
    expect(out.match(/not available/g)!.length).toBe(2);
    expect(out).not.toContain('84,021');
  });
  it('the section opts into the landscape named page and the stylesheet defines it (the wide table must fit the PDF)', () => {
    expect(html).toContain('india-mf-landscape');
    const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
    expect(css).toMatch(/@page india-mf-landscape\s*\{[^}]*size:\s*A4 landscape/);
    expect(css).toMatch(/\.india-mf-landscape\s*\{[^}]*page:\s*india-mf-landscape/);
    const preview = fs.readFileSync(path.join(ROOT, 'components/reports/ReportPreview.tsx'), 'utf8');
    expect(preview).toContain('IndiaMfInvestmentReportSection');
    expect(preview).toContain("byCode('india_mf_investment_report')");
  });
});
