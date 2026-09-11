// G6 Contract 3 (docs/country-programme/g6-data-contracts.md) — FX-rate
// lineage on financial_snapshots. Exercises the REAL loadDashboard()
// production code path against the same in-memory fake Supabase double
// used by tests/unit/aiResidualClosureFailClosed.test.ts, inspecting the
// actual upsert payload it writes.
import { describe, it, expect } from 'vitest';
import { loadDashboard } from '@/lib/services/dashboardData';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

describe('loadDashboard — financial_snapshots FX-rate lineage (G6 Contract 3)', () => {
  it('the upsert payload includes fx_rate_aud_inr and a fx_rate_date of today, using the same rate resolved for computeDashboard()', async () => {
    const handle = makeFakeSupabase({
      forecast_global_assumptions: [
        { assumption_key: 'fx_rate_aud_inr', is_active: true, country_code: null, assumption_value: 58 },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadDashboard('user-1', handle.client as any);

    const snapshotWrite = handle.writes.find((w) => w.table === 'financial_snapshots' && w.verb === 'upsert');
    expect(snapshotWrite).toBeDefined();
    const payload = snapshotWrite!.payload as Record<string, unknown>;
    expect(payload.fx_rate_aud_inr).toBe(58);
    expect(payload.fx_rate_date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('falls back to the default fx rate (56) when no forecast_global_assumptions row exists, matching getFxRateAudInr()\'s own fallback', async () => {
    const handle = makeFakeSupabase({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadDashboard('user-1', handle.client as any);

    const snapshotWrite = handle.writes.find((w) => w.table === 'financial_snapshots' && w.verb === 'upsert');
    const payload = snapshotWrite!.payload as Record<string, unknown>;
    expect(payload.fx_rate_aud_inr).toBe(56);
  });
});
