// G0-JA-1 Wave 1 — JA-D1 defect fix: lib/services/twinData.ts used to
// silently default an unresolved/unrecognised country_of_residence to 'AU'
// (`(profile?.country_of_residence as 'AU'|'IN') ?? 'AU'`), placing that
// user into an Australian benchmark cohort with no indication this
// happened. This suite drives the REAL exported loadTwinSourceData()
// against a hermetic in-memory fake of the Supabase query-builder chain
// (the same "deliberately narrow fake, not a general mock" convention
// established by tests/unit/iiR9GoalAllocationLifecycle.test.ts), plus
// module-level mocks for the four heavy downstream engines (Health Score,
// Resilience, Financial DNA, Goals) that loadTwinSourceData fans out to —
// none of those engines' own internal logic is under test here, only
// twinData.ts's own country-resolution and object-assembly behaviour.
import { describe, it, expect, vi } from 'vitest';

// twinData.ts imports createClient from '@/lib/supabase/server' (which
// imports next/headers) purely as a fallback for when no explicit client is
// passed. Every test below always passes an explicit fake client, so this
// fallback path never executes — stubbed out so this suite can run in a
// plain Node/vitest environment without a real Next.js request context
// (same convention already established by
// tests/unit/iiR9GoalAllocationLifecycle.test.ts's own vi.doMock of the
// same module).
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() should never be called — every test passes an explicit client.');
  },
}));

vi.mock('@/lib/services/healthScoreData', () => ({
  loadHealthScore: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Stable', components: [], recommendations: [], previousScore: null, scoreChange: null, history: [] }),
}));
vi.mock('@/lib/services/resilienceData', () => ({
  loadResilience: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Resilient', componentScores: [], risks: [], previousScore: null, scoreChange: null, history: [], eligibility: 'full' }),
}));
vi.mock('@/lib/services/financialDnaData', () => ({
  loadFinancialDna: vi.fn().mockResolvedValue({
    status: 'indicative',
    primaryProfileCode: 'balanced_builder',
    primaryScore: 70,
    secondaryProfileCode: null,
    secondaryScore: null,
    confidence: 60,
    confidenceBand: 'moderate',
    confidenceLabel: 'Moderate',
    profileChanged: false,
    candidates: [],
    drivers: [],
    strengths: [],
    risks: [],
    actions: [],
    traits: [],
    dataCompletenessPct: 50,
    modelVersion: 'test',
  }),
}));
vi.mock('@/lib/services/goalsData', () => ({
  computeGoalsPagePayload: vi.fn().mockResolvedValue({ payload: { goals: [], summary: null } }),
}));
vi.mock('@/lib/services/dashboardData', () => ({
  getFxRateAudInr: vi.fn().mockResolvedValue(56),
}));

// Imported AFTER the vi.mock calls above (hoisted by vitest regardless of
// declaration order, but kept in this order for readability).
import { loadTwinSourceData } from '@/lib/services/twinData';
import { annualGrossIncomeToIncomeBand } from '@/lib/engines/twin/taxonomy';

type Row = Record<string, unknown>;

// A deliberately narrow fake covering only the query shapes
// loadTwinSourceData's own first-batch Promise.all issues (user_profiles,
// households, expense_items, retirement_accounts, retirement_members,
// insurance_policies, investments, liabilities, assets,
// financial_snapshots) plus loadDashboardForTwin's own second round
// (income_sources, expense_items again, assets, liabilities, investments,
// retirement_accounts, insurance_policies, user_goals, financial_snapshots).
// Any table not explicitly populated below simply returns empty/null,
// which every one of these call sites already handles via `?? []`/`?? null`.
function makeFakeClient(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table] ?? [];
    let filtered = rows;
    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      // LR-FI-1: loadTwinSourceData's expense_items read now chains
      // .neq('owner', SMSF_OWNER) so an SMSF property's housing-coded expense
      // rows can't be read as the household's own housing cost. Implemented
      // with real filtering semantics (not a no-op passthrough) so this fake
      // genuinely exercises the exclusion rather than merely tolerating it.
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
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: 'no rows' } });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  // Cast: this fake only ever needs to satisfy the small subset of the
  // Supabase client surface loadTwinSourceData/loadDashboardForTwin actually
  // call — the same narrow-fake convention already established elsewhere in
  // this test suite (see file header).
  return { from } as unknown as Parameters<typeof loadTwinSourceData>[1];
}

function profileRow(countryOfResidence: string | null, overrides: Partial<Row> = {}): Row {
  return {
    user_id: 'user-1',
    date_of_birth: '1990-06-15',
    employment_status: 'Employed full-time',
    country_of_residence: countryOfResidence,
    secondary_country: null,
    preferred_currency: countryOfResidence === 'IN' ? 'INR' : 'AUD',
    ...overrides,
  };
}

describe('loadTwinSourceData — country resolution (JA-D1)', () => {
  it('positive AU test: confirmed AU profile resolves countryOfResidence=\'AU\' and the correct AU income band, never a fallback', async () => {
    const client = makeFakeClient({ user_profiles: [profileRow('AU')] });
    const outcome = await loadTwinSourceData('user-1', client);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.data.household.countryOfResidence).toBe('AU');
    // Zero recorded income in this fixture -> annualGrossIncome 0 -> whatever
    // annualGrossIncomeToIncomeBand('AU', 0) genuinely returns, computed the
    // same way production code computes it (not re-implemented in the test).
    expect(outcome.data.household.incomeBand).toBe(annualGrossIncomeToIncomeBand('AU', 0));
  });

  it('positive IN test: confirmed IN profile resolves countryOfResidence=\'IN\' and the correct IN income band, never a fallback', async () => {
    const client = makeFakeClient({ user_profiles: [profileRow('IN')] });
    const outcome = await loadTwinSourceData('user-1', client);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.data.household.countryOfResidence).toBe('IN');
    expect(outcome.data.household.incomeBand).toBe(annualGrossIncomeToIncomeBand('IN', 0));
  });

  it('missing-country negative control: country_of_residence = NULL returns the unavailable-state contract, never an AU-cohort result', async () => {
    const client = makeFakeClient({ user_profiles: [profileRow(null)] });
    const outcome = await loadTwinSourceData('user-1', client);
    expect(outcome.status).toBe('country_unresolved');
    // The core proof: there is no `data.household.countryOfResidence` at all
    // in this outcome shape for the unresolved branch — it is structurally
    // impossible for this contract to carry a fabricated 'AU' value (unlike
    // the old `?? 'AU'` line, which always produced a concrete 'AU' string
    // here regardless of the real profile state).
    expect('data' in outcome).toBe(false);
  });

  it('unsupported-country test: a forged/invalid non-enum country value also resolves to the unavailable-state contract (isKnownCountry guard), not a crash', async () => {
    const client = makeFakeClient({ user_profiles: [profileRow('ZZ')] });
    const outcome = await loadTwinSourceData('user-1', client);
    expect(outcome.status).toBe('country_unresolved');
  });

  it('no user_profiles row at all (onboarding never completed) also fails closed to the unavailable-state contract', async () => {
    const client = makeFakeClient({ user_profiles: [] });
    const outcome = await loadTwinSourceData('user-1', client);
    expect(outcome.status).toBe('country_unresolved');
  });
});
