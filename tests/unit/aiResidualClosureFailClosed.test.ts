// Module 11.0 residual closure — certification-database failure, provider
// containment, canonical-write containment, and concurrency semantics.
//
// Everything here exercises the REAL production path
// (`buildFinancialContextObject()` -> the real Module 1-10 certified loaders
// -> the real `AIContextCertificationService` -> the real `AIModelGateway`).
// The only substitution is BELOW the application: the Supabase server client
// is replaced by a controllable in-memory double that can be switched into
// a database-failure mode. No shared DEV infrastructure is disabled or
// damaged, and no live provider is ever contacted.
//
// Two genuine defects were found by these tests and fixed in
// `lib/ai/context/certifiedSourceClient.ts` + `financialContextObject.ts`:
//   D1 (fail-open): a database outage was coalesced to "no data" by every
//      loader, producing a PARTIAL root certification that `AIModelGateway`
//      ADMITS — i.e. a DB failure reached the provider with fabricated zeros.
//   D2 (canonical writes from a read path): one context build issued seven
//      `financial_snapshots` upserts (plus `goal_forecasts`/`goal_snapshots`
//      writes for a household with active goals), contradicting Module 11.0's
//      own "no AI writes to canonical financial data" claim.
// Test A4 is the negative control proving D1's fix is not vacuous.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { makeFakeSupabase, CANONICAL_FINANCIAL_TABLES, type FakeClientHandle, type FakeMode, type Row } from './support/fakeSupabaseClient';

// ---------------------------------------------------------------------------
// Wiring: each concurrent context build gets its OWN database double, so
// genuinely-concurrent success/failure cases can be run (brief section E).
// ---------------------------------------------------------------------------
const store = new AsyncLocalStorage<FakeClientHandle>();
let fallbackHandle: FakeClientHandle;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentHandle().client,
}));
vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: vi.fn(async () => 'test-run-id'),
  hashContext: vi.fn(() => 'test-hash'),
}));

function currentHandle(): FakeClientHandle {
  return store.getStore() ?? fallbackHandle;
}

// ---------------------------------------------------------------------------
// Synthetic fixtures — two isolated tenants.
// ---------------------------------------------------------------------------
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const THIS_MONTH = `${new Date().toISOString().slice(0, 7)}-01`;

function fixtures(userId: string, marker: number): Record<string, Row[]> {
  // `household_type` and `employment_status` carry a per-tenant unique token.
  // Both are allowlisted context fields, so if one tenant's build ever read
  // another tenant's row the token would appear verbatim in the wrong
  // context object — a leak oracle that cannot be satisfied by coincidence
  // the way a shared numeric magnitude can.
  return {
    user_profiles: [{ user_id: userId, preferred_currency: 'AUD', country_of_residence: 'AU', secondary_country: null, employment_status: `emp_tok_${marker}` }],
    households: [{ id: `hh-${marker}`, user_id: userId, household_type: `hh_tok_${marker}`, marital_status: 'married', dependants_count: 1 }],
    income_sources: [{ user_id: userId, is_active: true, source_name: `Salary-${marker}`, amount: marker, net_amount: marker * 0.75, frequency: 'monthly', master_item_key: 'salary', employer_name: `Employer-${marker}` }],
    expense_items: [{ user_id: userId, is_active: true, expense_name: `Rent-${marker}`, amount: marker / 4, frequency: 'monthly', is_essential: true, master_item_key: 'rent', expense_category: 'housing' }],
    assets: [{ user_id: userId, is_active: true, current_value: marker * 50, asset_class: 'property', master_item_key: 'home', country_code: 'AU', currency_code: 'AUD' }],
    liabilities: [{ user_id: userId, is_active: true, balance: marker * 20, interest_rate: 5, monthly_repayment: marker / 8, debt_type: 'mortgage', master_item_key: 'mortgage', country_code: 'AU', currency_code: 'AUD' }],
    investments: [],
    retirement_accounts: [],
    insurance_policies: [],
    user_goals: [],
    reports: [],
    forecast_runs: [],
    financial_twin_runs: [],
    financial_snapshots: [
      { user_id: userId, snapshot_month: THIS_MONTH, net_worth: marker * 30, monthly_income: marker, monthly_expenses: marker / 3, monthly_surplus: marker / 2, savings_rate: 0.3, total_assets: marker * 50, total_liabilities: marker * 20 },
    ],
  };
}

function handleFor(userId: string, marker: number, mode: FakeMode): FakeClientHandle {
  return makeFakeSupabase(fixtures(userId, marker), mode);
}

async function buildWith(handle: FakeClientHandle, userId: string) {
  const { buildFinancialContextObject } = await import('@/lib/ai/context/financialContextObject');
  return store.run(handle, () => buildFinancialContextObject(userId, { mode: 'FULL' }));
}

function canonicalWrites(handle: FakeClientHandle) {
  return handle.writes.filter((w) => CANONICAL_FINANCIAL_TABLES.includes(w.table));
}

/** Deep, order-stable snapshot of the canonical financial tables in a fixture
 *  set — the before/after oracle for "canonical financial-data diff: 0".
 *  `keys` is captured once BEFORE the build so that a table the double
 *  lazily materialises as an empty array during a read is not mistaken for a
 *  data change (an empty array is the absence of data, not a write). */
function canonicalSnapshot(tables: Record<string, Row[]>, keys: string[]): string {
  return JSON.stringify(Object.fromEntries(keys.map((t) => [t, tables[t] ?? []])));
}

function canonicalKeys(tables: Record<string, Row[]>): string[] {
  return CANONICAL_FINANCIAL_TABLES.filter((t) => tables[t]);
}

beforeEach(() => {
  fallbackHandle = handleFor(TENANT_A, 1000, 'healthy');
});

// ===========================================================================
// A. DATABASE FAILURE — FAIL CLOSED
// ===========================================================================
describe('A. Certification-database failure fails closed', () => {
  it('A1. a total database outage produces INVALID for every domain — never CERTIFIED, never a silent PARTIAL', async () => {
    const h = handleFor(TENANT_A, 1000, 'fail_all');
    const ctx = await buildWith(h, TENANT_A);

    expect(ctx.meta.certification_status).toBe('INVALID');
    expect(ctx.meta.integrity_status).toBe('INVALID');
    for (const [domain, cert] of Object.entries(ctx.domain_certification)) {
      expect(cert.status, `domain ${domain} must not be certified when the source database failed`).toBe('INVALID');
    }
    expect(Object.values(ctx.domain_certification).some((c) => c.status === 'CERTIFIED')).toBe(false);
  });

  it('A2. no financial section is populated when the source database failed (no fabricated zeros)', async () => {
    const h = handleFor(TENANT_A, 1000, 'fail_all');
    const ctx = await buildWith(h, TENANT_A);

    expect(ctx.cash_flow).toBeNull();
    expect(ctx.balance_sheet).toBeNull();
    expect(ctx.insurance).toBeNull();
    expect(ctx.cross_border).toBeNull();
    expect(ctx.household).toBeNull();
    expect(ctx.goals).toEqual([]);
    expect(ctx.reports).toEqual([]);
    expect(ctx.source_references).toEqual([]);
  });

  it('A3. currency integrity reports INVALID, not CERTIFIED, when the check could not be performed', async () => {
    const h = handleFor(TENANT_A, 1000, 'fail_all');
    const ctx = await buildWith(h, TENANT_A);
    // The pre-fix behaviour was CERTIFIED: `[].every()` on a null result set
    // is vacuously true, so an outage "passed" a check that never ran.
    expect(ctx.meta.currency_integrity_status).toBe('INVALID');
  });

  it('A3b. a partial outage (reads failing while writes still succeed) also fails closed', async () => {
    const h = handleFor(TENANT_A, 1000, 'fail_reads_allow_writes');
    const ctx = await buildWith(h, TENANT_A);
    expect(ctx.meta.certification_status).toBe('INVALID');
    expect(canonicalWrites(h)).toEqual([]);
  });

  it('A3c. the healthy control still certifies real domains — the gate is not a blanket "always INVALID"', async () => {
    const h = handleFor(TENANT_A, 1000, 'healthy');
    const ctx = await buildWith(h, TENANT_A);
    expect(ctx.meta.certification_status).not.toBe('INVALID');
    expect(ctx.domain_certification.cash_flow.status).toBe('CERTIFIED');
    expect(ctx.domain_certification.balance_sheet.status).toBe('CERTIFIED');
    expect(ctx.cash_flow).not.toBeNull();
  });

  // The two guards added by this round are independent, and each one alone
  // is enough to fail a TOTAL outage closed: the source-integrity gate sees
  // the failed reads, and `checkCurrencyIntegrity()` refuses to certify a
  // check it could not run. The negative-control pair below therefore uses
  // the one realistic scenario that defeats BOTH pre-fix behaviours at once
  // — a partial outage in which the four small currency-probe reads still
  // succeed while every heavy aggregation read fails.
  const CURRENCY_PROBE_TABLES = ['assets', 'liabilities', 'investments', 'retirement_accounts'];

  it('A4. NEGATIVE CONTROL — a default-allow source client ADMITS the same failure and reaches the provider (proves A1-A5 are not vacuous)', async () => {
    // Re-creates the pre-fix implementation exactly: a pass-through wrapper
    // that observes nothing and blocks nothing.
    vi.resetModules();
    vi.doMock('@/lib/ai/context/certifiedSourceClient', () => ({
      createCertifiedSourceClient: (base: unknown) => ({ client: base, integrity: { readFailures: [], blockedWrites: [] } }),
    }));
    try {
      const h = makeFakeSupabase(fixtures(TENANT_A, 1000), 'fail_reads_allow_writes', CURRENCY_PROBE_TABLES);
      const { buildFinancialContextObject } = await import('@/lib/ai/context/financialContextObject');
      const ctx = await store.run(h, () => buildFinancialContextObject(TENANT_A, { mode: 'FULL' }));

      // Without the gate the outage is indistinguishable from an empty
      // household: the root status lands on PARTIAL, which the gateway admits.
      expect(ctx.meta.certification_status).toBe('PARTIAL');
      expect(ctx.meta.certification_status).not.toBe('INVALID');

      const { AIModelGateway } = await import('@/lib/ai/gateway/aiModelGateway');
      const { MockAIProvider } = await import('@/lib/ai/providers/mockProvider');
      const provider = new MockAIProvider();
      const spy = vi.spyOn(provider, 'generateStructured');
      await new AIModelGateway(provider).generateExplanation(gatewayRequest(ctx));
      expect(spy, 'default-allow lets a database outage reach the provider — exactly the failure mode this round closes').toHaveBeenCalled();

      // ...and it also writes canonical financial data while doing it.
      expect(canonicalWrites(h).length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock('@/lib/ai/context/certifiedSourceClient');
      vi.resetModules();
    }
  });

  it('A5. the SAME scenario under the real implementation fails closed and writes nothing', async () => {
    const h = makeFakeSupabase(fixtures(TENANT_A, 1000), 'fail_reads_allow_writes', CURRENCY_PROBE_TABLES);
    const ctx = await buildWith(h, TENANT_A);
    expect(ctx.meta.certification_status).toBe('INVALID');
    expect(canonicalWrites(h)).toEqual([]);

    const { AIModelGateway } = await import('@/lib/ai/gateway/aiModelGateway');
    const { MockAIProvider } = await import('@/lib/ai/providers/mockProvider');
    const provider = new MockAIProvider();
    const spy = vi.spyOn(provider, 'generateStructured');
    const result = await new AIModelGateway(provider).generateExplanation(gatewayRequest(ctx));
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// B. PROVIDER MUST NOT BE REACHED AFTER A CERTIFICATION FAILURE
// ===========================================================================
function gatewayRequest(context: Awaited<ReturnType<typeof buildWith>>) {
  return {
    taskType: 'score_explanation' as const,
    systemPrompt: 'system',
    userPrompt: 'why is my savings rate what it is?',
    prompt: { id: 'p1', version: 1 } as never,
    model: { id: 'm1', model_identifier: 'mock-model' } as never,
    context,
    userId: TENANT_A,
    householdId: null,
  };
}

describe('B. Provider containment after a certification failure', () => {
  it('B1. a DB-failure context never reaches the provider: context assembled NO, provider invoked NO', async () => {
    const h = handleFor(TENANT_A, 1000, 'fail_all');
    const ctx = await buildWith(h, TENANT_A);

    const { AIModelGateway } = await import('@/lib/ai/gateway/aiModelGateway');
    const { MockAIProvider } = await import('@/lib/ai/providers/mockProvider');
    const provider = new MockAIProvider();
    const generateSpy = vi.spyOn(provider, 'generateStructured');
    const gateway = new AIModelGateway(provider);

    const result = await gateway.generateExplanation(gatewayRequest(ctx));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.executionStatus).toBe('rejected_certification');
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it('B2. an AI governance-store (model registry) read failure fails closed and never reaches the provider', async () => {
    const h = handleFor(TENANT_A, 1000, 'fail_all');
    const { resolveModelForTask } = await import('@/lib/ai/modelRegistry');
    await expect(store.run(h, () => resolveModelForTask('score_explanation'))).rejects.toThrow();

    // ...and a null model (the other failure shape) is rejected before any
    // provider call, with the provider proven untouched.
    const { AIModelGateway } = await import('@/lib/ai/gateway/aiModelGateway');
    const { MockAIProvider } = await import('@/lib/ai/providers/mockProvider');
    const provider = new MockAIProvider();
    const spy = vi.spyOn(provider, 'generateStructured');
    const healthy = handleFor(TENANT_A, 1000, 'healthy');
    const ctx = await buildWith(healthy, TENANT_A);
    const res = await new AIModelGateway(provider).generateExplanation({ ...gatewayRequest(ctx), model: null });
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('B3. an AI governance-store (prompt registry) read failure resolves to null, which fails closed before the provider', async () => {
    const h = handleFor(TENANT_A, 1000, 'fail_all');
    const { getActivePrompt } = await import('@/lib/ai/promptRegistry');
    const prompt = await store.run(h, () => getActivePrompt('PR-AI-001', 'AU'));
    expect(prompt).toBeNull();

    const { AIModelGateway } = await import('@/lib/ai/gateway/aiModelGateway');
    const { MockAIProvider } = await import('@/lib/ai/providers/mockProvider');
    const provider = new MockAIProvider();
    const spy = vi.spyOn(provider, 'generateStructured');
    const healthy = handleFor(TENANT_A, 1000, 'healthy');
    const ctx = await buildWith(healthy, TENANT_A);
    const res = await new AIModelGateway(provider).generateExplanation({ ...gatewayRequest(ctx), prompt: null });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.executionStatus).toBe('rejected_certification');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// C. CANONICAL FINANCIAL DATA MUST REMAIN UNTOUCHED
// ===========================================================================
describe('C. Canonical financial data is never written by the AI context path', () => {
  it('C1. a DB-failure build leaves canonical financial data byte-identical (diff: 0)', async () => {
    const tables = fixtures(TENANT_A, 1000);
    const h = makeFakeSupabase(tables, 'fail_all');
    const keys = canonicalKeys(tables);
    const before = canonicalSnapshot(tables, keys);
    await buildWith(h, TENANT_A);
    expect(canonicalSnapshot(tables, keys)).toBe(before);
    expect(canonicalWrites(h)).toEqual([]);
  });

  it('C2. a partial outage where writes WOULD succeed still writes nothing (no zeroed snapshot over real history)', async () => {
    const tables = fixtures(TENANT_A, 1000);
    const h = makeFakeSupabase(tables, 'fail_reads_allow_writes');
    const keys = canonicalKeys(tables);
    const before = canonicalSnapshot(tables, keys);
    await buildWith(h, TENANT_A);
    expect(canonicalSnapshot(tables, keys)).toBe(before);
    expect(canonicalWrites(h)).toEqual([]);
  });

  it('C3. even a fully HEALTHY build performs zero canonical writes (regression guard for the 7 financial_snapshots upserts)', async () => {
    const tables = fixtures(TENANT_A, 1000);
    const h = makeFakeSupabase(tables, 'healthy');
    const keys = canonicalKeys(tables);
    const before = canonicalSnapshot(tables, keys);
    const ctx = await buildWith(h, TENANT_A);
    expect(ctx.domain_certification.cash_flow.status).toBe('CERTIFIED');
    expect(canonicalSnapshot(tables, keys)).toBe(before);
    expect(canonicalWrites(h).map((w) => `${w.verb} ${w.table}`)).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});

// ===========================================================================
// D. CONCURRENT CERTIFICATION
// ===========================================================================
describe('D. Concurrent certification is deterministic and side-effect free', () => {
  it('D1. two concurrent certifications of the same user/domain/source version agree exactly (0 contradictory states)', async () => {
    const hA = handleFor(TENANT_A, 1000, 'healthy');
    const hB = handleFor(TENANT_A, 1000, 'healthy');
    const [first, second] = await Promise.all([buildWith(hA, TENANT_A), buildWith(hB, TENANT_A)]);

    expect(second.domain_certification).toEqual(first.domain_certification);
    expect(second.meta.certification_status).toBe(first.meta.certification_status);
    expect(second.meta.currency_integrity_status).toBe(first.meta.currency_integrity_status);
    const contradictions = Object.keys(first.domain_certification).filter(
      (d) => first.domain_certification[d as keyof typeof first.domain_certification].status !== second.domain_certification[d as keyof typeof second.domain_certification].status
    );
    expect(contradictions).toEqual([]);
    expect([...canonicalWrites(hA), ...canonicalWrites(hB)]).toEqual([]);
  });

  it('D2. concurrent certifications for two different tenants never leak across tenants', async () => {
    const hA = handleFor(TENANT_A, 1111, 'healthy');
    const hB = handleFor(TENANT_B, 2222, 'healthy');
    const [ctxA, ctxB] = await Promise.all([buildWith(hA, TENANT_A), buildWith(hB, TENANT_B)]);

    const jsonA = JSON.stringify(ctxA);
    const jsonB = JSON.stringify(ctxB);
    expect(ctxA.meta.user_scope_identifier).not.toBe(ctxB.meta.user_scope_identifier);
    expect(jsonA).not.toContain(TENANT_B.replace(/-/g, '').slice(0, 16));
    expect(jsonB).not.toContain(TENANT_A.replace(/-/g, '').slice(0, 16));
    // Each tenant's unique, allowlisted tokens must appear only in that
    // tenant's own context — nowhere in the other's.
    expect(ctxA.household?.household_type).toBe('hh_tok_1111');
    expect(ctxB.household?.household_type).toBe('hh_tok_2222');
    expect(jsonA).not.toContain('hh_tok_2222');
    expect(jsonA).not.toContain('emp_tok_2222');
    expect(jsonB).not.toContain('hh_tok_1111');
    expect(jsonB).not.toContain('emp_tok_1111');
    expect(ctxA.cash_flow?.monthly_gross_income).toBe(1111);
    expect(ctxB.cash_flow?.monthly_gross_income).toBe(2222);
    expect([...canonicalWrites(hA), ...canonicalWrites(hB)]).toEqual([]);
  });

  it('D3. certification is derived per request and holds no shared mutable state — 10 concurrent builds all agree', async () => {
    const handles = Array.from({ length: 10 }, () => handleFor(TENANT_A, 1000, 'healthy'));
    const contexts = await Promise.all(handles.map((h) => buildWith(h, TENANT_A)));
    const reference = JSON.stringify(contexts[0].domain_certification);
    for (const c of contexts) expect(JSON.stringify(c.domain_certification)).toBe(reference);
    expect(handles.flatMap(canonicalWrites)).toEqual([]);
  });
});

// ===========================================================================
// E. CONCURRENT SUCCESS / FAILURE
// ===========================================================================
describe('E. Concurrent success + controlled failure is deterministic, never a race', () => {
  it('E1. 25 concurrent success/failure pairs produce the same authoritative state every time', async () => {
    for (let round = 0; round < 25; round++) {
      const good = handleFor(TENANT_A, 1000, 'healthy');
      const bad = handleFor(TENANT_A, 1000, 'fail_all');
      const [okCtx, failCtx] = await Promise.all([buildWith(good, TENANT_A), buildWith(bad, TENANT_A)]);

      expect(okCtx.domain_certification.cash_flow.status, `round ${round}`).toBe('CERTIFIED');
      expect(okCtx.meta.certification_status, `round ${round}`).not.toBe('INVALID');
      expect(failCtx.meta.certification_status, `round ${round}`).toBe('INVALID');
      expect(failCtx.domain_certification.cash_flow.status, `round ${round}`).toBe('INVALID');
      expect([...canonicalWrites(good), ...canonicalWrites(bad)], `round ${round}`).toEqual([]);
    }
  }, 60000);

  it('E2. the failing branch never contaminates the succeeding branch (each request owns its own certification)', async () => {
    const good = handleFor(TENANT_A, 1000, 'healthy');
    const bad = handleFor(TENANT_A, 1000, 'fail_all');
    const [okCtx] = await Promise.all([buildWith(good, TENANT_A), buildWith(bad, TENANT_A)]);
    expect(okCtx.cash_flow?.monthly_gross_income).toBe(1000);
    expect(okCtx.meta.currency_integrity_status).toBe('CERTIFIED');
  });
});
