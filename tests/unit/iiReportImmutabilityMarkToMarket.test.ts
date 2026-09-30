// Investment Intelligence — PO-mandated regression proof, scenario 5 of the
// mark-to-market golden-fixture programme (2026-09-30): a finalized report
// (lib/services/reportsData.ts's generateReport()) is an IMMUTABLE snapshot
// at generation time and must NEVER be silently recalculated by the
// mark-to-market fix (commits 4072260, c632533) or by anything else. A report
// generated before the fix landed must show exactly what it showed then, even
// after the underlying NAV feed has since moved the "current" figure.
//
// CODE-LEVEL BASIS (read in full for this task): reportsData.ts's getReport()
// and getReportByRenderToken() are pure SELECTs against `reports` and
// `report_sections` -- neither function imports, calls, or references
// analyticsRepository.ts, analyticsOrchestrator.ts, or any `ii_*` table at
// all. There is no code path connecting a stored report's read side to the
// mark-to-market fix, by construction, not merely by the values happening to
// agree. The two tests below prove this two ways:
//   1. positively -- getReport() returns the EXACT stored section_data_json,
//      unchanged, even when a live recompute of the same underlying data
//      (with the mark-to-market fix applied) would now produce a materially
//      different figure;
//   2. structurally -- getReport() never issues a single query against any
//      `ii_*` table; the hermetic fake below doesn't even populate them.
//
// Same `vi.mock('@/lib/supabase/server', ...)` + PostgREST-shaped fake
// pattern as tests/unit/reportStalenessImports.test.ts (WP-06), which
// documents this exact house style for reportsData-adjacent tests.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { getReport } from '@/lib/services/reportsData';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import type { SupabaseClient } from '@supabase/supabase-js';

// Same hermetic mock Supabase query builder as
// tests/unit/iiNavMarkToMarket.test.ts -- supports both the direct-await
// shape (ii_instruments) and the .range()-paged shape fetchAllRows uses for
// every other analyticsRepository.ts query (pagination.ts).
type MockRow = Record<string, unknown>;

function applyOrder(rows: MockRow[], clauses: Array<{ col: string; ascending: boolean }>): MockRow[] {
  const result = [...rows];
  for (let i = clauses.length - 1; i >= 0; i--) {
    const { col, ascending } = clauses[i];
    result.sort((a, b) => {
      const av = a[col] as string | number;
      const bv = b[col] as string | number;
      if (av < bv) return ascending ? -1 : 1;
      if (av > bv) return ascending ? 1 : -1;
      return 0;
    });
  }
  return result;
}

function makeQueryBuilder(rows: MockRow[]) {
  let filtered = rows;
  const orderClauses: Array<{ col: string; ascending: boolean }> = [];
  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      const set = new Set(vals);
      filtered = filtered.filter((r) => set.has(r[col]));
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderClauses.push({ col, ascending: opts?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      const sorted = applyOrder(filtered, orderClauses);
      const page = sorted.slice(from, to + 1);
      return Promise.resolve({ data: page, error: null });
    },
    then(resolve: (v: { data: MockRow[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      const sorted = applyOrder(filtered, orderClauses);
      const capped = sorted.slice(0, 1000);
      return Promise.resolve({ data: capped, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function makeIiSupabaseMock(tables: Record<string, MockRow[]>): SupabaseClient {
  return {
    from(table: string) {
      return makeQueryBuilder(tables[table] ?? []);
    },
  } as unknown as SupabaseClient;
}

const USER = 'user-report-immutability';
const REPORT_ID = 'report-1';
const INSTRUMENT_ID = 'inst-report-mtm';

// The exact figures a report generated on 2026-08-05 (BEFORE the household's
// daily NAV feed moved past its last statement) would have stored -- computed
// by hand from the pre-fix data available at generation time: 500 units x the
// certified statement value of 100/unit = 50000, dated to the statement's own
// as_of_date, with an XIRR of exactly 10% frozen at generation time.
const FROZEN_SECTION_DATA = {
  currentValue: 50000,
  currentValueDate: '2026-08-01',
  portfolioXirr: 0.1,
};

function reportRow(): Row {
  return {
    id: REPORT_ID,
    user_id: USER,
    report_type_code: 'monthly_financial_health',
    report_month: '2026-08-01',
    as_of_date: '2026-08-05',
    title: 'Monthly Financial Health Report — August 2026',
    status: 'ready',
    version_number: 1,
    revises_report_id: null,
    reporting_currency: 'INR',
    country_scope: 'household',
    data_completeness_pct: 100,
    generated_at: '2026-08-05T00:00:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: null,
    created_at: '2026-08-05T00:00:00.000Z',
  };
}

function reportSectionRow(): Row {
  return {
    id: 'section-1',
    report_id: REPORT_ID,
    user_id: USER,
    section_code: 'investment_performance',
    section_title: 'Investment Performance',
    display_order: 5,
    section_status: 'complete',
    section_data_json: FROZEN_SECTION_DATA,
    narrative_text: 'Your portfolio was worth ₹50,000 as of 01 Aug 2026.',
    chart_data_json: null,
    source_references_json: {},
    confidence_level: 'high',
    limitation_text: null,
  };
}

describe('GOLD-005: a finalized report is never recalculated by the mark-to-market fix', () => {
  it('getReport() returns the exact frozen figures even though the SAME underlying data, recomputed live today, now yields a materially different current value', async () => {
    // ---- Side A: what the STORED report says (generated 2026-08-05) -------
    const { client } = makeFakeSupabase({
      reports: [reportRow()],
      report_sections: [reportSectionRow()],
    });
    const serverModule = await import('@/lib/supabase/server');
    vi.mocked(serverModule.createClient).mockResolvedValue(client as never);

    const stored = await getReport(USER, REPORT_ID);
    expect(stored).not.toBeNull();
    expect(stored!.sections).toHaveLength(1);
    expect(stored!.sections[0].sectionData).toEqual(FROZEN_SECTION_DATA);

    // ---- Side B: what a LIVE recompute of the same household's investment
    // data says TODAY, now that the daily NAV feed has moved on past the
    // 2026-08-01 statement (exactly the mark-to-market fix's own scenario 1) --
    // built independently via loadAnalyticsDataset/runAnalytics, never via
    // reportsData.ts, to prove these are two genuinely disconnected code paths.
    const tables: Record<string, MockRow[]> = {
      ii_portfolio_truth_status: [],
      ii_transactions: [],
      ii_holding_snapshots: [
        { id: 'snap-rep-1', user_id: USER, instrument_id: INSTRUMENT_ID, as_of_date: '2026-08-01', units: 500, value: 50000, currency_code: 'INR', quality_status: 'certified' },
      ],
      ii_instruments: [{ id: INSTRUMENT_ID, instrument_name: 'Report Fund', base_currency: 'INR', country_of_domicile: 'IN' }],
      ii_prices_nav: [
        { id: 'nav-rep-1', instrument_id: INSTRUMENT_ID, price_date: '2026-08-01', price: 100, data_version: 'nav-v1', quality_status: 'ok' },
        // The daily NAV job kept running for the month and a half AFTER this
        // report was generated -- exactly what the fix is FOR.
        { id: 'nav-rep-2', instrument_id: INSTRUMENT_ID, price_date: '2026-09-25', price: 112.5, data_version: 'nav-v1', quality_status: 'ok' },
      ],
      ii_instrument_benchmarks: [],
      ii_benchmark_series: [],
      ii_risk_free_rates: [],
    };
    const iiClient = makeIiSupabaseMock(tables);

    const { dataset } = await loadAnalyticsDataset(iiClient, USER, { asOfDate: new Date('2026-09-29T00:00:00.000Z') });
    const liveScheme = dataset!.schemes.find((s) => s.instrumentId === INSTRUMENT_ID)!;
    // The live figure has genuinely moved: 500 x 112.5 = 56250, NOT the
    // frozen report's 50000.
    expect(liveScheme.currentValue).toBe(56250);
    expect(liveScheme.currentValue).not.toBe(FROZEN_SECTION_DATA.currentValue);

    // ---- The assertion that matters: re-reading the SAME stored report,
    // after proving the live figure has diverged, still returns the ORIGINAL
    // frozen numbers -- nothing about computing the live value above touched
    // the stored report row.
    const rereadAfterLiveDiverged = await getReport(USER, REPORT_ID);
    expect(rereadAfterLiveDiverged!.sections[0].sectionData).toEqual(FROZEN_SECTION_DATA);
    expect((rereadAfterLiveDiverged!.sections[0].sectionData as typeof FROZEN_SECTION_DATA).currentValue).toBe(50000);
  });

  it('getReport() never queries any ii_* table -- structural proof it cannot be coupled to the mark-to-market fix', async () => {
    const { client, requests } = makeFakeSupabase({
      reports: [reportRow()],
      report_sections: [reportSectionRow()],
      // Deliberately NOT populated: if getReport() ever queried one of these,
      // the fake would still answer (with an empty array), so the real proof
      // is the `requests` log asserted below, not a failure here.
    });
    const serverModule = await import('@/lib/supabase/server');
    vi.mocked(serverModule.createClient).mockResolvedValue(client as never);

    const result = await getReport(USER, REPORT_ID);
    expect(result).not.toBeNull();

    const queriedTables = new Set(requests.map((r) => r.table));
    expect(queriedTables).toEqual(new Set(['reports', 'report_sections']));
    for (const table of queriedTables) {
      expect(table.startsWith('ii_')).toBe(false);
    }
  });
});
