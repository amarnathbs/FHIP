// NAV 1 R1 — unit tests for the report-pinning WRITE-PATH integration
// (reportNavDependencyWriter.ts): the piece that was disclosed as "not yet
// wired" through every prior NAV1 continuation, now actually called from
// reportsData.ts's real finalization path. These tests prove, with no live
// database:
//   1. finalizing (a report with real Premium chapter data) writes the
//      expected rows;
//   2. "previewing" (this codebase's closest real analogue: a report with no
//      Premium content at all, e.g. free-tier, or the not_eligible early
//      return which never even calls this function) does not;
//   3. re-finalizing the same report is idempotent (same onConflict target,
//      same rows, no duplication risk introduced by this layer -- exact
//      duplicate-prevention is DB-enforced and separately proven live
//      against a real Postgres in scripts/nav1_r1_writepath_independent_verification.ts
//      and nav1_0172_pglite_verification.mjs);
//   4. a write failure is never silently swallowed.

import { describe, it, expect } from 'vitest';
import { deriveReportNavDependencyInputs, writeReportNavDependencyManifest, type ReportNavDependencyWriteClient } from '@/lib/services/investment-intelligence/pc6/reportNavDependencyWriter';
import type { PremiumSourceData } from '@/lib/services/reportSnapshotResolver';
import { BENCHMARK_LOOKBACK_DAYS } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const AS_OF = '2026-09-18';

function subtractDaysForTest(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Builds a minimal PremiumSourceData-shaped fixture with only the fields deriveReportNavDependencyInputs() actually reads -- cast to the real type at the boundary, the same pragmatic pattern this repo's own live-dev fixtures use for a large cross-module interface. */
function fixturePremium(overrides: Partial<PremiumSourceData>): PremiumSourceData {
  return {
    investments: [],
    insurancePolicies: [],
    // WP-06: the raw assets / liabilities / income / expense register copies
    // were replaced by the canonical appendix + investment reconciliation.
    canonicalAppendix: null,
    canonicalInvestments: null,
    forecastReportData: null,
    goalsOnTrackHistory: [],
    fxRateAudInr: 55,
    investmentPerformance: null,
    sip: null,
    xray: null,
    taxAndCost: null,
    reviewItems: null,
    ...overrides,
  } as unknown as PremiumSourceData;
}

const INSTR_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const INSTR_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const INSTR_C = 'cccccccc-0000-0000-0000-000000000003';

describe('deriveReportNavDependencyInputs', () => {
  it('null premium (no Premium content at all) derives zero inputs', () => {
    expect(deriveReportNavDependencyInputs(null, AS_OF)).toEqual([]);
  });

  it('investmentPerformance produces xirr_since_inception + twr_since_opening_balance (both bounded at the real earliest cash-flow date) + rolling_return_window (unbounded by transaction date) per scheme', () => {
    const premium = fixturePremium({
      investmentPerformance: {
        results: { schemes: [{ instrumentId: INSTR_A }, { instrumentId: INSTR_B }] } as never,
        warnings: [],
        earliestCashFlowDateByInstrument: { [INSTR_A]: '2021-05-10' }, // INSTR_B deliberately missing -- must fail closed (null), not assume "today"
      },
    });
    const inputs = deriveReportNavDependencyInputs(premium, AS_OF);
    const forA = inputs.filter((i) => i.instrumentId === INSTR_A);
    const forB = inputs.filter((i) => i.instrumentId === INSTR_B);
    expect(forA.map((i) => i.basis).sort()).toEqual(['rolling_return_window', 'twr_since_opening_balance', 'xirr_since_inception']);
    expect(forA.find((i) => i.basis === 'xirr_since_inception')?.earliestTransactionDate).toBe('2021-05-10');
    expect(forA.find((i) => i.basis === 'twr_since_opening_balance')?.earliestTransactionDate).toBe('2021-05-10');
    expect(forB.find((i) => i.basis === 'xirr_since_inception')?.earliestTransactionDate ?? null).toBeNull();
  });

  it('sip produces sip_xray_transaction_history bounded at the real earliest transaction date', () => {
    const premium = fixturePremium({
      sip: { results: {} as never, warnings: [], earliestTransactionDateByInstrument: { [INSTR_C]: '2019-02-01' } },
    });
    const inputs = deriveReportNavDependencyInputs(premium, AS_OF);
    expect(inputs).toEqual([{ instrumentId: INSTR_C, basis: 'sip_xray_transaction_history', reportAsOfDate: AS_OF, earliestTransactionDate: '2019-02-01' }]);
  });

  it('X-Ray never produces a dependency row, on purpose -- it reads ii_holding_snapshots, never ii_prices_nav (a real, grounded finding, not an oversight)', () => {
    const premium = fixturePremium({
      xray: { results: { someXrayField: true } as never, warnings: [] } as never,
    });
    expect(deriveReportNavDependencyInputs(premium, AS_OF)).toEqual([]);
  });

  it('taxAndCost produces tax_lot_fifo bounded at the real earliest acquisition date', () => {
    const premium = fixturePremium({
      taxAndCost: { results: {} as never, asOfDate: AS_OF, taxProfileSource: 'none', earliestAcquisitionDateByInstrument: { [INSTR_A]: '2017-08-20' } },
    });
    const inputs = deriveReportNavDependencyInputs(premium, AS_OF);
    expect(inputs).toEqual([{ instrumentId: INSTR_A, basis: 'tax_lot_fifo', reportAsOfDate: AS_OF, earliestTransactionDate: '2017-08-20' }]);
  });

  it('a report that touches all chapters for the same instrument produces one row per (instrument, basis), never a duplicate for the identical pair', () => {
    const premium = fixturePremium({
      investmentPerformance: { results: { schemes: [{ instrumentId: INSTR_A }] } as never, warnings: [], earliestCashFlowDateByInstrument: { [INSTR_A]: '2020-01-01' } },
      sip: { results: {} as never, warnings: [], earliestTransactionDateByInstrument: { [INSTR_A]: '2020-01-01' } },
      taxAndCost: { results: {} as never, asOfDate: AS_OF, taxProfileSource: 'none', earliestAcquisitionDateByInstrument: { [INSTR_A]: '2020-01-01' } },
    });
    const inputs = deriveReportNavDependencyInputs(premium, AS_OF);
    const keys = inputs.map((i) => `${i.instrumentId}|${i.basis}`);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate (instrument, basis) pair
    expect(keys.sort()).toEqual(
      [`${INSTR_A}|xirr_since_inception`, `${INSTR_A}|twr_since_opening_balance`, `${INSTR_A}|rolling_return_window`, `${INSTR_A}|sip_xray_transaction_history`, `${INSTR_A}|tax_lot_fifo`].sort()
    );
  });
});

/** A tiny in-memory fake standing in for the real Supabase admin client -- captures every upsert call for inspection without touching a network or a real database. */
function fakeClient() {
  const calls: Array<{ table: string; rows: unknown[]; options: unknown }> = [];
  let nextError: { message: string } | null = null;
  const client: ReportNavDependencyWriteClient = {
    from(table: string) {
      return {
        async upsert(rows: unknown[], options: unknown) {
          calls.push({ table, rows, options });
          return { error: nextError };
        },
      };
    },
  };
  return { client, calls, setNextError: (e: { message: string } | null) => (nextError = e) };
}

describe('writeReportNavDependencyManifest', () => {
  it('finalizing (real Premium content) writes the expected rows, upserted against the report-scoped unique target', async () => {
    const { client, calls } = fakeClient();
    const premium = fixturePremium({
      sip: { results: {} as never, warnings: [], earliestTransactionDateByInstrument: { [INSTR_A]: '2019-02-01' } },
    });
    const result = await writeReportNavDependencyManifest(client, 'report-1', premium, AS_OF);
    expect(result.rowsWritten).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('ii_report_nav_dependencies');
    expect(calls[0].options).toEqual({ onConflict: 'report_id,instrument_id,basis' });
    expect(calls[0].rows).toEqual([{ report_id: 'report-1', instrument_id: INSTR_A, basis: 'sip_xray_transaction_history', nav_date_from: '2019-02-01', nav_date_to: AS_OF }]);
  });

  it('previewing (no Premium content -- this codebase\'s only real analogue to a draft, since every generateReport() call that reaches this function already creates a real persisted report) writes NOTHING and never even calls the client', async () => {
    const { client, calls } = fakeClient();
    const result = await writeReportNavDependencyManifest(client, 'report-2', null, AS_OF);
    expect(result.rowsWritten).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('re-finalizing the same report is idempotent: calling it twice with the same inputs produces two identical upsert calls against the SAME (report_id, instrument_id, basis) target -- the DB-level unique index (proven live in nav1_0172_pglite_verification.mjs and nav1_r1_writepath_independent_verification.ts) is what actually prevents a duplicate row; this test proves the write-path itself sends the identical, idempotent-shaped request both times, never a second, different-shaped request', async () => {
    const { client, calls } = fakeClient();
    const premium = fixturePremium({
      taxAndCost: { results: {} as never, asOfDate: AS_OF, taxProfileSource: 'none', earliestAcquisitionDateByInstrument: { [INSTR_A]: '2017-08-20' } },
    });
    const first = await writeReportNavDependencyManifest(client, 'report-3', premium, AS_OF);
    const second = await writeReportNavDependencyManifest(client, 'report-3', premium, AS_OF);
    expect(first).toEqual(second);
    expect(calls).toHaveLength(2);
    expect(calls[0].rows).toEqual(calls[1].rows);
    expect(calls[0].options).toEqual(calls[1].options);
  });

  it('a real write error is never silently swallowed -- it throws, so the caller (generateReport()) sees a genuine failure rather than a false success', async () => {
    const { client, setNextError } = fakeClient();
    setNextError({ message: 'connection reset' });
    const premium = fixturePremium({
      sip: { results: {} as never, warnings: [], earliestTransactionDateByInstrument: { [INSTR_A]: '2019-02-01' } },
    });
    await expect(writeReportNavDependencyManifest(client, 'report-4', premium, AS_OF)).rejects.toThrow(/connection reset/);
  });
});

// Keep the BENCHMARK_LOOKBACK_DAYS-derived rolling window import genuinely
// exercised (not just imported and unused) -- confirms the writer's
// rolling_return_window rows use the SAME constant navRetentionPolicy.ts
// and reportNavDependencyManifest.ts already ground their own numbers in,
// never a third, independently-invented one.
describe('rolling_return_window grounding, end to end through the writer', () => {
  it('a rolling_return_window row computed via the writer uses BENCHMARK_LOOKBACK_DAYS exactly', async () => {
    const { client, calls } = fakeClient();
    const premium = fixturePremium({
      investmentPerformance: { results: { schemes: [{ instrumentId: INSTR_A }] } as never, warnings: [], earliestCashFlowDateByInstrument: {} },
    });
    await writeReportNavDependencyManifest(client, 'report-5', premium, AS_OF);
    const rollingRow = (calls[0].rows as Array<{ basis: string; nav_date_from: string | null }>).find((r) => r.basis === 'rolling_return_window');
    expect(rollingRow?.nav_date_from).toBe(subtractDaysForTest(AS_OF, BENCHMARK_LOOKBACK_DAYS));
  });
});
