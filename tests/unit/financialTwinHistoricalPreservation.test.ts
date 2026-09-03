// G0-JA-1 Wave 1 — JA-D1's "historical-output considerations" requirement:
// a previously-generated Financial Twin run computed under the old silent
// AU-default behaviour must not be retroactively regenerated, altered, or
// flagged as wrong by this fix. This suite proves two things against the
// REAL generateFinancialTwin()/listTwinRuns() (no mocking of twinData.ts —
// the real loadTwinSourceData() and the real getUserHomeCountry() resolver
// both run against the fake client below):
//   1. A generate attempt for a now-unresolved-country user takes the new
//      fail-closed exit BEFORE any financial_twin_runs/metric_results/
//      insights row is written — there is nothing here for a future
//      "don't touch history" rule to have to guard, because nothing new is
//      ever created in this state.
//   2. A pre-existing historical run row (as if generated years ago, before
//      this fix existed, for a user whose country has since become
//      unresolved) is read back completely unchanged.
import { describe, it, expect, vi } from 'vitest';

// See tests/unit/twinDataCountryResolution.test.ts's header comment — same
// reason, same convention already established by
// tests/unit/iiR9GoalAllocationLifecycle.test.ts.
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() should never be called — every test passes an explicit client.');
  },
}));

import { generateFinancialTwin, listTwinRuns } from '@/lib/services/financialTwinService';

type Row = Record<string, unknown>;

function makeFakeClient(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows;
    let pendingInsert: Row | Row[] | null = null;
    const builder = {
      select() {
        return builder;
      },
      insert(payload: Row | Row[]) {
        pendingInsert = payload;
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      // LR-FI-1: loadTwinSourceData's expense_items read now chains
      // .neq('owner', SMSF_OWNER). Real filtering semantics, not a no-op.
      neq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] !== val);
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      maybeSingle() {
        return finish(filtered[0] ?? null);
      },
      single() {
        return finish(filtered[0] ?? null, !filtered[0]);
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return finish(filtered).then(resolve, reject);
      },
    };
    function finish(result: Row | Row[] | null, forceError = false) {
      if (pendingInsert) {
        const items = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        for (const item of items) rows.push({ id: `generated-${rows.length}`, ...item });
        return Promise.resolve({ data: Array.isArray(pendingInsert) ? items : items[0], error: null });
      }
      return Promise.resolve({ data: result, error: forceError ? { message: 'no rows' } : null });
    }
    return builder;
  }
  return { from } as unknown as Parameters<typeof generateFinancialTwin>[1];
}

const HISTORICAL_RUN: Row = {
  id: 'historical-run-1',
  user_id: 'user-1',
  run_date: '2026-01-15',
  cohort_tier: 1,
  overall_confidence: 82.5,
  metrics_compared: 40,
  ahead_count: 20,
  aligned_count: 10,
  behind_count: 10,
  not_comparable_count: 27,
  data_completeness_pct: 60,
  status: 'indicative',
  created_at: '2026-01-15T00:00:00.000Z',
};

describe('generateFinancialTwin — historical-output protection (JA-D1)', () => {
  it('an unresolved-country generate attempt writes NO new financial_twin_runs/metric_results/insights row', async () => {
    const tables: Record<string, Row[]> = {
      user_profiles: [{ user_id: 'user-1', country_of_residence: null, secondary_country: null, preferred_currency: 'AUD' }],
      financial_twin_runs: [{ ...HISTORICAL_RUN }],
      financial_twin_metric_results: [],
      financial_twin_insights: [],
    };
    const client = makeFakeClient(tables);

    const outcome = await generateFinancialTwin('user-1', client);
    expect(outcome.status).toBe('country_unresolved');

    // No new run row was inserted — the table still contains exactly the
    // one pre-existing historical row, nothing appended.
    expect(tables.financial_twin_runs).toHaveLength(1);
    expect(tables.financial_twin_runs[0]).toEqual(HISTORICAL_RUN);
    expect(tables.financial_twin_metric_results).toHaveLength(0);
    expect(tables.financial_twin_insights).toHaveLength(0);
  });

  it('the pre-existing historical run is still readable, byte-identical, via listTwinRuns after the fix is applied', async () => {
    const tables: Record<string, Row[]> = {
      user_profiles: [{ user_id: 'user-1', country_of_residence: null, secondary_country: null, preferred_currency: 'AUD' }],
      financial_twin_runs: [{ ...HISTORICAL_RUN }],
    };
    const client = makeFakeClient(tables);

    const runs = await listTwinRuns('user-1', client);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      id: 'historical-run-1',
      runDate: '2026-01-15',
      cohortTier: 1,
      overallConfidence: 82.5,
      metricsCompared: 40,
      aheadCount: 20,
      alignedCount: 10,
      behindCount: 10,
      notComparableCount: 27,
      dataCompletenessPct: 60,
      status: 'indicative',
      createdAt: '2026-01-15T00:00:00.000Z',
    });
  });
});
