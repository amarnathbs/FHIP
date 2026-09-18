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
          instrument_id: 'instrument-1',
          transaction_type: 'purchase',
          transaction_date: '2020-01-01',
          gross_amount: 10000,
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
      ii_tax_lots: [{ user_id: USER_ID, account_id: 'account-1', instrument_id: 'instrument-1', units_remaining: 500, cost_per_unit: 20 }],
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
    expect(h.costValue).toBe(10000); // 500 units * 20 cost/unit
    expect(h.unitBalance).toBe(500);
    expect(h.navDate).toBe('2022-01-01');
    expect(h.nav).toBe(30); // 15000 / 500
    expect(h.marketValue).toBe(15000);
    expect(h.gainLoss).toBe(5000);
    expect(h.returnPct).toBeCloseTo(0.5, 6);
    expect(h.dataQuality.status).toBe('ok');
    expect(h.xirr.status).toBe('CALCULATED');
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
          instrument_id: 'instrument-2',
          transaction_type: 'purchase',
          transaction_date: '2020-01-01',
          gross_amount: 5000,
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
      ii_tax_lots: [{ user_id: USER_ID, account_id: 'account-2', instrument_id: 'instrument-2', units_remaining: 156.618, cost_per_unit: 25 }],
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
  });

  it('returns empty when the user has no investment positions', async () => {
    const { client } = makeFakeSupabase({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadHoldingsTable(client as any, USER_ID);
    expect(result.empty).toBe(true);
    expect(result.holdings).toEqual([]);
  });
});
