// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// Unit coverage for holdingsRepository.ts's loadHoldingsTable(): the
// Folio/ISIN/Cost Value/Unit Balance/NAV/Market Value/Gain-Loss/Return%/
// XIRR assembly per scheme, run through the REAL analytics pipeline
// (loadAnalyticsDataset + runAnalytics + PerformanceEngine) against a fake
// Supabase client — not a reimplementation of that pipeline's own math.
import { describe, it, expect } from 'vitest';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const USER_ID = 'user-1';

describe('loadHoldingsTable', () => {
  it('assembles a healthy (reconciled) scheme row with cost/units/NAV/market value/gain-loss/return/XIRR/registrar', async () => {
    const tables = {
      ii_portfolio_truth_status: [
        {
          user_id: USER_ID,
          account_id: 'account-1',
          instrument_id: 'instrument-1',
          status: 'certified',
          unit_variance_within_tolerance: true,
          latest_source_document_id: 'doc-1',
          history_completeness: 'complete_from_inception',
        },
      ],
      ii_transactions: [
        {
          user_id: USER_ID,
          account_id: 'account-1',
          instrument_id: 'instrument-1',
          transaction_type: 'purchase',
          transaction_date: '2020-01-01',
          gross_amount: 10000,
          units: 500,
          currency_code: 'INR',
          status: 'parsed',
        },
      ],
      ii_holding_snapshots: [
        {
          user_id: USER_ID,
          account_id: 'account-1',
          instrument_id: 'instrument-1',
          as_of_date: '2022-01-01',
          units: 500,
          value: 15000,
          currency_code: 'INR',
          quality_status: 'certified',
          source_document_id: 'doc-1',
        },
      ],
      ii_instruments: [{ id: 'instrument-1', instrument_name: 'Test Flexi Cap Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF123456789' }],
      ii_accounts: [{ id: 'account-1', user_id: USER_ID, folio_number: 'FOLIO-XYZ', institution_name: 'Test AMC', currency_code: 'INR' }],
      ii_source_documents: [{ id: 'doc-1', source_detected: 'cams' }],
      ii_instrument_benchmarks: [],
      ii_risk_free_rates: [],
      ii_prices_nav: [],
    };
    const { client } = makeFakeSupabase(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);

    expect(result.empty).toBe(false);
    expect(result.holdings).toHaveLength(1);
    const h = result.holdings[0];
    expect(h.folioNumber).toBe('FOLIO-XYZ');
    expect(h.isin).toBe('INF123456789');
    expect(h.registrar).toBe('CAMS');
    expect(h.costValue).toBe(10000); // sum of purchase transactions for units still held, no disposals — see costBasis.ts
    expect(h.unitBalance).toBe(500);
    expect(h.navDate).toBe('2022-01-01');
    expect(h.nav).toBe(30); // 15000 / 500
    expect(h.marketValue).toBe(15000);
    expect(h.gainLoss).toBe(5000);
    expect(h.returnPct).toBeCloseTo(0.5, 6);
    expect(h.dataQuality.status).toBe('ok');
    expect(h.xirr.status).toBe('CALCULATED');
    // 2026-09-29 fix (resolution-guidance links): carried through so the
    // client can deep-link back to the statement that produced this
    // position — see HoldingsTable.tsx's "Resolve on statement" link.
    expect(h.sourceDocumentId).toBe('doc-1');
  });

  it('withholds numeric figures and shows an "unresolved" data-quality badge for a scheme that fails reconciliation, with the AI-fallback flag left at its default (disabled)', async () => {
    delete process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED;
    const tables = {
      ii_portfolio_truth_status: [
        {
          user_id: USER_ID,
          account_id: 'account-2',
          instrument_id: 'instrument-2',
          status: 'failed',
          unit_variance_within_tolerance: false,
          latest_source_document_id: 'doc-2',
          history_completeness: 'complete_from_inception',
        },
      ],
      ii_transactions: [
        {
          user_id: USER_ID,
          account_id: 'account-2',
          instrument_id: 'instrument-2',
          transaction_type: 'purchase',
          transaction_date: '2020-01-01',
          gross_amount: 5000,
          units: 156.618,
          currency_code: 'INR',
          status: 'parsed',
        },
      ],
      ii_holding_snapshots: [
        {
          user_id: USER_ID,
          account_id: 'account-2',
          instrument_id: 'instrument-2',
          as_of_date: '2022-01-01',
          units: 156.618, // a known-variance-shaped figure — deliberately not trusted at face value
          value: 8000,
          currency_code: 'INR',
          quality_status: 'warning',
          source_document_id: 'doc-2',
        },
      ],
      ii_instruments: [{ id: 'instrument-2', instrument_name: 'Disputed Axis Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF987654321' }],
      ii_accounts: [{ id: 'account-2', user_id: USER_ID, folio_number: 'FOLIO-ABC', institution_name: 'Test AMC', currency_code: 'INR' }],
      ii_source_documents: [{ id: 'doc-2', source_detected: 'cams' }],
      ii_instrument_benchmarks: [],
      ii_risk_free_rates: [],
      ii_prices_nav: [],
    };
    const { client } = makeFakeSupabase(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);

    expect(result.holdings).toHaveLength(1);
    const h = result.holdings[0];
    expect(h.dataQuality.status).toBe('unresolved');
    expect(h.dataQuality.detail).toContain('AI-assisted reconciliation is disabled');
    // Never a silently-wrong number: every value-based figure is withheld, not shown at face value.
    expect(h.costValue).toBeNull();
    expect(h.unitBalance).toBeNull();
    expect(h.marketValue).toBeNull();
    expect(h.gainLoss).toBeNull();
    expect(h.returnPct).toBeNull();
    expect(h.xirr.status).not.toBe('CALCULATED');
    // 2026-09-29 fix (resolution-guidance links): this is precisely the case
    // that previously had no resolution path from this table at all — the
    // source document id must survive so HoldingsTable.tsx can link the
    // "unresolved" badge straight to the statement's own Resolve/Assign
    // actions instead of leaving only a hover tooltip.
    expect(h.sourceDocumentId).toBe('doc-2');
  });

  it('uses the PC6 scheme-master canonical name over the RTA-parsed name when a current scheme-master row exists (2026-09-20)', async () => {
    const tables = {
      ii_portfolio_truth_status: [
        { user_id: USER_ID, account_id: 'account-3', instrument_id: 'instrument-3', status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'doc-3', history_completeness: 'complete_from_inception' },
      ],
      ii_transactions: [{ user_id: USER_ID, account_id: 'account-3', instrument_id: 'instrument-3', transaction_type: 'purchase', transaction_date: '2020-01-01', gross_amount: 1000, units: 10, currency_code: 'INR', status: 'parsed' }],
      ii_holding_snapshots: [{ user_id: USER_ID, account_id: 'account-3', instrument_id: 'instrument-3', as_of_date: '2022-01-01', units: 10, value: 1200, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-3' }],
      // The RTA's own printed name still carries its internal scheme-code
      // prefix, exactly like real production data ("108MFGPG-UTI MNC Fund...").
      ii_instruments: [{ id: 'instrument-3', instrument_name: '999XYZ-Messy RTA Fund Name', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF111111111' }],
      ii_accounts: [{ id: 'account-3', user_id: USER_ID, folio_number: 'FOLIO-DEF', institution_name: 'Test AMC', currency_code: 'INR' }],
      ii_source_documents: [{ id: 'doc-3', source_detected: 'cams' }],
      ii_instrument_benchmarks: [],
      ii_risk_free_rates: [],
      ii_prices_nav: [],
      ii_scheme_master: [{ instrument_id: 'instrument-3', scheme_name: 'Clean AMFI Canonical Fund Name', effective_to: null }],
    };
    const { client } = makeFakeSupabase(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].schemeName).toBe('Clean AMFI Canonical Fund Name');
  });

  it('returns empty when the user has no investment positions', async () => {
    const { client } = makeFakeSupabase({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);
    expect(result.empty).toBe(true);
    expect(result.holdings).toEqual([]);
  });

  // BENCH-1 (2026-09-30): the Holdings row must show an honest, reasoned
  // "unavailable" for its Benchmark column when nothing has ever been
  // mapped -- never a blank cell and never a fabricated 0%.
  it('reports BENCHMARK_MAPPING_MISSING for a scheme with no ii_instrument_benchmarks row', async () => {
    const tables = {
      ii_portfolio_truth_status: [
        { user_id: USER_ID, account_id: 'account-4', instrument_id: 'instrument-4', status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'doc-4', history_completeness: 'complete_from_inception' },
      ],
      ii_transactions: [{ user_id: USER_ID, account_id: 'account-4', instrument_id: 'instrument-4', transaction_type: 'purchase', transaction_date: '2020-01-01', gross_amount: 1000, units: 10, currency_code: 'INR', status: 'parsed' }],
      ii_holding_snapshots: [{ user_id: USER_ID, account_id: 'account-4', instrument_id: 'instrument-4', as_of_date: '2022-01-01', units: 10, value: 1200, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-4' }],
      ii_instruments: [{ id: 'instrument-4', instrument_name: 'Unmapped Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF222222222' }],
      ii_accounts: [{ id: 'account-4', user_id: USER_ID, folio_number: 'FOLIO-GHI', institution_name: 'Test AMC', currency_code: 'INR' }],
      ii_source_documents: [{ id: 'doc-4', source_detected: 'cams' }],
      ii_instrument_benchmarks: [],
      ii_risk_free_rates: [],
      ii_prices_nav: [],
    };
    const { client } = makeFakeSupabase(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].benchmark.status).toBe('MISSING_REFERENCE_DATA');
    expect(result.holdings[0].benchmark.qualityFlag).toBe('BENCHMARK_MAPPING_MISSING');
    expect(result.holdings[0].benchmark.value).toBeUndefined();
  });

  // A mapping exists, but the mapped benchmark's own licence_status blocks
  // real ingestion (exactly BENCH-1's current real-world state for every
  // Indian index — see SOURCE_DECISION.md / PO-PC6-1). Must still be an
  // honest unavailable, not a fabricated number from whatever placeholder
  // series might exist.
  it('reports BENCHMARK_HISTORY_INCOMPLETE when the mapped benchmark is licence_required', async () => {
    const tables = {
      ii_portfolio_truth_status: [
        { user_id: USER_ID, account_id: 'account-5', instrument_id: 'instrument-5', status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'doc-5', history_completeness: 'complete_from_inception' },
      ],
      ii_transactions: [{ user_id: USER_ID, account_id: 'account-5', instrument_id: 'instrument-5', transaction_type: 'purchase', transaction_date: '2020-01-01', gross_amount: 1000, units: 10, currency_code: 'INR', status: 'parsed' }],
      ii_holding_snapshots: [{ user_id: USER_ID, account_id: 'account-5', instrument_id: 'instrument-5', as_of_date: '2022-01-01', units: 10, value: 1200, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-5' }],
      ii_instruments: [{ id: 'instrument-5', instrument_name: 'Mapped But Blocked Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF333333333' }],
      ii_accounts: [{ id: 'account-5', user_id: USER_ID, folio_number: 'FOLIO-JKL', institution_name: 'Test AMC', currency_code: 'INR' }],
      ii_source_documents: [{ id: 'doc-5', source_detected: 'cams' }],
      ii_instrument_benchmarks: [
        {
          instrument_id: 'instrument-5',
          benchmark_id: 'bm-nifty50-tri',
          relationship_type: 'primary',
          effective_from: '1900-01-01',
          effective_to: null,
          // The fake client's select() ignores the embed string and returns
          // fixture rows verbatim, so the embedded relation is hand-shaped
          // here exactly as PostgREST would return it for a real FK embed.
          ii_benchmarks: { benchmark_key: 'IN_NIFTY_50_TRI', benchmark_label: 'Nifty 50 TRI', return_type: 'TRI', licence_status: 'licence_required', lifecycle_status: 'active' },
        },
      ],
      ii_risk_free_rates: [],
      ii_prices_nav: [],
    };
    const { client } = makeFakeSupabase(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].benchmark.status).toBe('MISSING_REFERENCE_DATA');
    expect(result.holdings[0].benchmark.qualityFlag).toBe('BENCHMARK_HISTORY_INCOMPLETE');
    expect(result.holdings[0].benchmark.detail).toContain('licence');
  });

  // The one path that SHOULD produce a real number: a licensed, mapped
  // benchmark with a published series actually covering the window.
  it('computes a real comparable return when a mapped benchmark has a licence-clear series covering the window', async () => {
    const tables = {
      ii_portfolio_truth_status: [
        { user_id: USER_ID, account_id: 'account-6', instrument_id: 'instrument-6', status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'doc-6', history_completeness: 'complete_from_inception' },
      ],
      ii_transactions: [{ user_id: USER_ID, account_id: 'account-6', instrument_id: 'instrument-6', transaction_type: 'purchase', transaction_date: '2020-01-01', gross_amount: 1000, units: 10, currency_code: 'INR', status: 'parsed' }],
      ii_holding_snapshots: [{ user_id: USER_ID, account_id: 'account-6', instrument_id: 'instrument-6', as_of_date: '2021-01-01', units: 10, value: 1200, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-6' }],
      ii_instruments: [{ id: 'instrument-6', instrument_name: 'Fully Covered Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF444444444' }],
      ii_accounts: [{ id: 'account-6', user_id: USER_ID, folio_number: 'FOLIO-MNO', institution_name: 'Test AMC', currency_code: 'INR' }],
      ii_source_documents: [{ id: 'doc-6', source_detected: 'cams' }],
      ii_instrument_benchmarks: [
        {
          instrument_id: 'instrument-6',
          benchmark_id: 'bm-hypothetical-licensed',
          relationship_type: 'primary',
          effective_from: '1900-01-01',
          effective_to: null,
          ii_benchmarks: { benchmark_key: 'TEST_LICENSED_INDEX_TRI', benchmark_label: 'Test Licensed Index TRI', return_type: 'TRI', licence_status: 'public_open', lifecycle_status: 'active' },
        },
      ],
      ii_benchmark_series: [
        { benchmark_id: 'bm-hypothetical-licensed', series_date: '2020-01-01', value: 100 },
        { benchmark_id: 'bm-hypothetical-licensed', series_date: '2021-01-01', value: 110 },
      ],
      ii_risk_free_rates: [],
      ii_prices_nav: [],
    };
    const { client } = makeFakeSupabase(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].benchmark.status).toBe('CALCULATED');
    expect(result.holdings[0].benchmark.value?.benchmarkKey).toBe('TEST_LICENSED_INDEX_TRI');
    expect(result.holdings[0].benchmark.value?.pointToPointReturn).toBeCloseTo(0.1, 6); // 110/100 - 1
  });
});
