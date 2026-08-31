// Module 11.0 residual closure — LIVE hosted-DEV certification.
//
// Brief sections F (live PARTIAL), G (live INVALID), H (cross-domain
// independence), I (raw forgery negative control) and J (cleanup).
//
// WHAT IS LIVE HERE
//   * A real hosted DEV Supabase project (ref guarded below — this suite
//     refuses to run against anything else, so it can never touch production).
//   * Real synthetic auth users created through the Auth admin API, signed in
//     with a real password grant, holding real user JWTs.
//   * Real canonical financial rows inserted THROUGH each user's own JWT, so
//     real RLS applies exactly as it does in production.
//   * The real, unmodified `buildFinancialContextObject()` ->
//     `AIContextCertificationService` -> `AIModelGateway` chain.
//
// WHAT IS SUBSTITUTED
//   * `@/lib/supabase/server`'s `createClient()`, which in production reads
//     the session from `next/headers` cookies. Outside a Next request there
//     are no cookies, so it is replaced by a real `@supabase/supabase-js`
//     client carrying the same user's JWT — the same RLS identity, obtained a
//     different way. Nothing else is mocked.
//   * `MockAIProvider` stands in for a real provider, as it does everywhere in
//     Module 11.0 — no live provider call is made in this phase.
//
// NO CERTIFICATION STATE IS EVER WRITTEN DIRECTLY. Every PARTIAL/INVALID
// below is DERIVED by the normal path from real canonical source data:
//   * PARTIAL  <- a household with income recorded but no expenses.
//   * INVALID  <- a household holding an asset denominated in a currency
//                 outside Module 11.0's supported set (USD is a valid FK in
//                 `currencies`, so this is a genuine supported-source path,
//                 not a manufactured row).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Environment + hard DEV guard
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = path.join(repoRoot, '.env.local');
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_DEV_REF) {
  throw new Error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project. This suite never touches production.`);
}

// The app's own admin client (used by recordAiRun) reads these from the
// process environment.
process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;

// ---------------------------------------------------------------------------
// Substitute only the cookie-bound client factory.
// ---------------------------------------------------------------------------
let activeUserClient: SupabaseClient | null = null;
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    if (!activeUserClient) throw new Error('no active synthetic user client');
    return activeUserClient;
  },
}));

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN_TAG = `m11res-${Date.now()}`;
interface Tenant {
  label: string;
  userId: string;
  email: string;
  accessToken: string;
  client: SupabaseClient;
}
const tenants: Record<string, Tenant> = {};

async function createTenant(label: string): Promise<Tenant> {
  const email = `${RUN_TAG}-${label}@fhip-synthetic.test`;
  const password = `Synthetic!${RUN_TAG}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create synthetic user ${label}: ${error?.message}`);

  const signIn = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await signIn.json();
  if (!session.access_token) throw new Error(`could not sign in synthetic user ${label}: ${JSON.stringify(session).slice(0, 200)}`);

  const client = createSupabaseJsClient(BASE, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  const tenant: Tenant = { label, userId: data.user.id, email, accessToken: session.access_token, client };
  tenants[label] = tenant;
  return tenant;
}

/** Runs `fn` with the given tenant's real, RLS-scoped client installed as the
 *  app's server client — i.e. exactly the identity the certification path
 *  would have inside that user's own request. */
async function asTenant<T>(t: Tenant, fn: () => Promise<T>): Promise<T> {
  activeUserClient = t.client;
  try {
    return await fn();
  } finally {
    activeUserClient = null;
  }
}

async function buildContextFor(t: Tenant) {
  const { buildFinancialContextObject } = await import('@/lib/ai/context/financialContextObject');
  return asTenant(t, () => buildFinancialContextObject(t.userId, { mode: 'FULL' }));
}

/** The real eligibility decision: the gateway, with a real DEV model row and a
 *  real DEV prompt row, and a provider we can observe. Returns whether the
 *  provider was reached. */
async function decideEligibility(context: Awaited<ReturnType<typeof buildContextFor>>, t: Tenant) {
  const { AIModelGateway } = await import('@/lib/ai/gateway/aiModelGateway');
    // Module 11.1: gateway now enforces entitlement before any provider call and
    // defaults to the real DB-backed gate; these tests are about certification
    // and source integrity, so the bypass is explicit here.
    const { allowAllGate } = await import('@/tests/unit/support/entitlementGateStubs');
  const { MockAIProvider } = await import('@/lib/ai/providers/mockProvider');
  const provider = new MockAIProvider();
  const spy = vi.spyOn(provider, 'generateStructured');
  const result = await new AIModelGateway(provider, allowAllGate()).generateExplanation({
    taskType: 'score_explanation',
    systemPrompt: 'system',
    userPrompt: 'explain my position',
    prompt: livePromptRow as never,
    model: liveModelRow as never,
    context,
    userId: t.userId,
    householdId: null,
    requestClass: 'standard' as const,
  });
  return { result, providerInvoked: spy.mock.calls.length > 0 };
}


/** Insert that FAILS LOUDLY. A silently-rejected fixture insert would make
 *  every derived-state assertion below meaningless (an empty household also
 *  certifies as UNAVAILABLE), so setup must never swallow an error. */
async function mustInsert(t: Tenant, table: string, row: Record<string, unknown>) {
  const { error } = await t.client.from(table).insert(row);
  if (error) throw new Error(`fixture insert into ${table} for ${t.label} failed: ${error.message} | ${error.details ?? ''} | ${error.hint ?? ''}`);
}

async function mustUpsert(t: Tenant, table: string, row: Record<string, unknown>) {
  const { error } = await t.client.from(table).upsert(row);
  if (error) throw new Error(`fixture upsert into ${table} for ${t.label} failed: ${error.message} | ${error.details ?? ''} | ${error.hint ?? ''}`);
}

let liveModelRow: Record<string, unknown>;
let livePromptRow: Record<string, unknown>;

// ---------------------------------------------------------------------------
// Setup: three synthetic tenants with genuinely different source data.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  const { data: models } = await admin.from('ai_model_registry').select('*').eq('active', true).eq('approved', true).limit(1);
  liveModelRow = (models ?? [])[0] as Record<string, unknown>;
  expect(liveModelRow, 'DEV must have an active, approved model row (migration 0110 seed)').toBeTruthy();
  const { data: prompts } = await admin.from('ai_prompt_templates').select('*').eq('prompt_code', 'PR-AI-001').limit(1);
  livePromptRow = (prompts ?? [])[0] as Record<string, unknown>;
  expect(livePromptRow, 'DEV must have the seeded PR-AI-001 prompt row').toBeTruthy();

  // --- F: a household that must DERIVE cash-flow PARTIAL ---------------
  const partial = await createTenant('partial');
  await mustUpsert(partial, 'user_profiles', { user_id: partial.userId, full_name: 'Synthetic Partial', country_of_residence: 'AU', preferred_currency: 'AUD', employment_status: 'employed', country_confirmed_at: new Date().toISOString(), country_updated_at: new Date().toISOString() });
  await mustInsert(partial, 'income_sources', { user_id: partial.userId, source_name: 'Synthetic salary', income_type: 'salary', amount: 9000, frequency: 'monthly', currency_code: 'AUD', is_active: true });
  // deliberately NO expense_items -> certifyCashFlow() must return PARTIAL

  // --- G: a household that must DERIVE cross-border INVALID ------------
  const invalid = await createTenant('invalid');
  await mustUpsert(invalid, 'user_profiles', { user_id: invalid.userId, full_name: 'Synthetic Invalid', country_of_residence: 'AU', preferred_currency: 'AUD', employment_status: 'employed', country_confirmed_at: new Date().toISOString(), country_updated_at: new Date().toISOString() });
  await mustInsert(invalid, 'income_sources', { user_id: invalid.userId, source_name: 'Synthetic salary', income_type: 'salary', amount: 9000, frequency: 'monthly', currency_code: 'AUD', is_active: true });
  await mustInsert(invalid, 'expense_items', { user_id: invalid.userId, expense_name: 'Synthetic rent', expense_category: 'housing', amount: 3000, frequency: 'monthly', currency_code: 'AUD', is_active: true });
  await mustInsert(invalid, 'assets', { user_id: invalid.userId, asset_name: 'Synthetic USD account', asset_class: 'cash', current_value: 25000, currency_code: 'USD', country_code: 'AU', is_active: true });
  await mustInsert(invalid, 'liabilities', { user_id: invalid.userId, liability_name: 'Synthetic loan', debt_type: 'personal_loan', balance: 5000, interest_rate: 7, monthly_repayment: 300, currency_code: 'AUD', country_code: 'AU', is_active: true });

  // --- H: one household carrying three genuinely different domain states
  const mixed = await createTenant('mixed');
  await mustUpsert(mixed, 'user_profiles', { user_id: mixed.userId, full_name: 'Synthetic Mixed', country_of_residence: 'AU', preferred_currency: 'AUD', employment_status: 'employed', country_confirmed_at: new Date().toISOString(), country_updated_at: new Date().toISOString() });
  await mustInsert(mixed, 'income_sources', { user_id: mixed.userId, source_name: 'Synthetic salary', income_type: 'salary', amount: 12000, frequency: 'monthly', currency_code: 'AUD', is_active: true });
  await mustInsert(mixed, 'expense_items', { user_id: mixed.userId, expense_name: 'Synthetic rent', expense_category: 'housing', amount: 4000, frequency: 'monthly', currency_code: 'AUD', is_active: true });
  await mustInsert(mixed, 'assets', { user_id: mixed.userId, asset_name: 'Synthetic USD account', asset_class: 'cash', current_value: 40000, currency_code: 'USD', country_code: 'AU', is_active: true });
  await mustInsert(mixed, 'liabilities', { user_id: mixed.userId, liability_name: 'Synthetic mortgage', debt_type: 'mortgage', balance: 250000, interest_rate: 6, monthly_repayment: 1800, currency_code: 'AUD', country_code: 'AU', is_active: true });
  // no insurance_policies -> certifyInsurance() must return PARTIAL
});

// ===========================================================================
// F. LIVE DEV — PARTIAL
// ===========================================================================
describe('F. Live DEV — PARTIAL is derived, not manufactured', () => {
  it('F1. expected PARTIAL, actual PARTIAL — derived by the normal certification path from real DEV data', async () => {
    const ctx = await buildContextFor(tenants.partial);
    expect(ctx.domain_certification.cash_flow.status).toBe('PARTIAL');
    expect(ctx.domain_certification.cash_flow.reason).toMatch(/expense/i);
    expect(ctx.meta.certification_status).toBe('PARTIAL');
  });

  it('F2. PARTIAL is not CERTIFIED, and is not silently upgraded anywhere in the context', async () => {
    const ctx = await buildContextFor(tenants.partial);
    expect(ctx.domain_certification.cash_flow.status).not.toBe('CERTIFIED');
    expect(ctx.meta.certification_status).not.toBe('CERTIFIED');
    expect(ctx.meta.calculation_status).toBe('partial');
    // The domain is reported as incomplete, never as complete.
    expect(ctx.data_quality.complete_domains).not.toContain('cash_flow');
    expect(ctx.data_quality.incomplete_domains).toContain('cash_flow');
    expect(ctx.data_quality.missing_fields.join(' ')).toMatch(/cash_flow/);
  });

  it('F3. the real eligibility decision treats PARTIAL as RESTRICTED (admitted, but explicitly flagged) per existing policy', async () => {
    const ctx = await buildContextFor(tenants.partial);
    const { result, providerInvoked } = await decideEligibility(ctx, tenants.partial);
    // Existing Module 11.0 policy: PARTIAL is admitted but the context that
    // travels carries its own PARTIAL certification and its missing-field
    // list, so nothing downstream can mistake it for certified truth.
    expect(providerInvoked).toBe(true);
    expect(result.ok).toBe(true);
    expect(ctx.meta.certification_status).toBe('PARTIAL');
    expect(ctx.domain_certification.cash_flow.reason).toBeTruthy();
  });
});

// ===========================================================================
// G. LIVE DEV — INVALID
// ===========================================================================
describe('G. Live DEV — INVALID is derived, not manufactured', () => {
  it('G1. expected INVALID, actual INVALID — an unsupported-currency holding fails the currency-integrity gate', async () => {
    const ctx = await buildContextFor(tenants.invalid);
    expect(ctx.meta.currency_integrity_status).toBe('INVALID');
    expect(ctx.domain_certification.cross_border.status).toBe('INVALID');
    expect(ctx.meta.certification_status).toBe('INVALID');
  });

  it('G2. INVALID blocks the personalised context: the provider is never reached', async () => {
    const ctx = await buildContextFor(tenants.invalid);
    const { result, providerInvoked } = await decideEligibility(ctx, tenants.invalid);
    expect(providerInvoked).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.executionStatus).toBe('rejected_certification');
  });

  it('G3. the INVALID domain contributes no financial content to any provider-facing section', async () => {
    const ctx = await buildContextFor(tenants.invalid);
    expect(ctx.cross_border).toBeNull();
    expect(ctx.data_quality.unavailable_modules).toContain('cross_border');
  });
});

// ===========================================================================
// H. CROSS-DOMAIN NEGATIVE CONTROL
// ===========================================================================
describe('H. Cross-domain independence', () => {
  it('H1. one household simultaneously holds CERTIFIED, PARTIAL and INVALID domains, each derived independently', async () => {
    const ctx = await buildContextFor(tenants.mixed);
    expect(ctx.domain_certification.cash_flow.status).toBe('CERTIFIED');
    expect(ctx.domain_certification.insurance.status).toBe('PARTIAL');
    expect(ctx.domain_certification.cross_border.status).toBe('INVALID');
  });

  it('H2. the CERTIFIED domain unlocks nothing else: 0 domains upgraded by a neighbour', async () => {
    const ctx = await buildContextFor(tenants.mixed);
    // Each domain keeps its own verdict; no domain inherits cash_flow's.
    expect(ctx.domain_certification.cross_border.status).not.toBe('CERTIFIED');
    expect(ctx.domain_certification.insurance.status).not.toBe('CERTIFIED');
    expect(ctx.data_quality.complete_domains).toContain('cash_flow');
    expect(ctx.data_quality.complete_domains).not.toContain('cross_border');
    expect(ctx.data_quality.complete_domains).not.toContain('insurance');
    // The INVALID domain contributes nothing; the PARTIAL one is included but
    // flagged; the CERTIFIED one is included outright.
    expect(ctx.cross_border).toBeNull();
    expect(ctx.insurance).not.toBeNull();
    expect(ctx.cash_flow).not.toBeNull();
  });

  it('H3. and the whole request still fails closed, because the root rollup honours the INVALID domain', async () => {
    const ctx = await buildContextFor(tenants.mixed);
    expect(ctx.meta.certification_status).toBe('INVALID');
    const { providerInvoked, result } = await decideEligibility(ctx, tenants.mixed);
    expect(providerInvoked).toBe(false);
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// I. RAW FORGERY NEGATIVE CONTROL
// ===========================================================================
describe('I. Raw same-tenant forgery through PostgREST is blocked', () => {
  it('I1. a user cannot forge their own ai_runs audit row (no insert policy exists)', async () => {
    const t = tenants.partial;
    const { error } = await t.client.from('ai_runs').insert({
      user_id: t.userId,
      request_type: 'score_explanation',
      context_version: 'ai-context-1.0.0',
      context_hash: 'forged',
      provider: 'mock',
      model: 'mock-standard-1',
      execution_status: 'success',
    });
    expect(error, 'a same-tenant ai_runs INSERT must be rejected by RLS').toBeTruthy();
  });

  it('I2. a user cannot flip a governance-table row to make an unapproved model/prompt authoritative', async () => {
    const t = tenants.partial;
    const modelUpdate = await t.client.from('ai_model_registry').update({ approved: true, active: true }).eq('id', liveModelRow.id as string).select('id');
    expect(modelUpdate.error || (modelUpdate.data ?? []).length === 0, 'ai_model_registry must not be user-writable').toBeTruthy();

    const promptUpdate = await t.client.from('ai_prompt_templates').update({ status: 'ACTIVE' }).eq('id', livePromptRow.id as string).select('id');
    expect(promptUpdate.error || (promptUpdate.data ?? []).length === 0, 'ai_prompt_templates must not be user-writable').toBeTruthy();

    const promptInsert = await t.client.from('ai_prompt_templates').insert({
      prompt_code: `FORGED-${RUN_TAG}`,
      prompt_name: 'forged',
      task_type: 'score_explanation',
      system_prompt: 'x',
      developer_prompt: 'x',
      context_schema_version: '1',
      output_schema_version: '1',
      safety_policy_version: '1',
      status: 'ACTIVE',
      version: 1,
    });
    expect(promptInsert.error, 'ai_prompt_templates must not accept a user INSERT').toBeTruthy();
  });

  it('I3. governance tables are invisible to an ordinary authenticated user (positive control: service role sees them)', async () => {
    const t = tenants.partial;
    for (const table of ['ai_model_registry', 'ai_prompt_templates', 'ai_evaluations', 'ai_safety_events']) {
      const { data } = await t.client.from(table).select('*');
      expect((data ?? []).length, `${table} must expose zero rows to an ordinary user`).toBe(0);
    }
    const { data: adminModels } = await admin.from('ai_model_registry').select('id');
    expect((adminModels ?? []).length, 'positive control: the rows really do exist').toBeGreaterThan(0);
  });

  it('I4. a user cannot read another tenant\'s ai_runs rows', async () => {
    const { data } = await tenants.invalid.client.from('ai_runs').select('id,user_id').eq('user_id', tenants.partial.userId);
    expect((data ?? []).length).toBe(0);
  });
});

// ===========================================================================
// C (live). Canonical financial data untouched by the live context builds
// ===========================================================================
describe('C-live. The live context builds wrote no canonical financial data', () => {
  it('CL1. no financial_snapshots / goal_forecasts / goal_snapshots / score rows were created for any synthetic tenant', async () => {
    for (const t of Object.values(tenants)) {
      for (const table of ['financial_snapshots', 'goal_forecasts', 'goal_snapshots', 'financial_health_scores', 'financial_dna_profiles', 'resilience_scores']) {
        const { data } = await admin.from(table).select('user_id').eq('user_id', t.userId);
        expect((data ?? []).length, `${table} must be empty for ${t.label} — the AI context path must never write canonical data`).toBe(0);
      }
    }
  });
});

// ===========================================================================
// J. CLEANUP + INDEPENDENT VERIFICATION
// ===========================================================================
afterAll(async () => {
  const ids = Object.values(tenants).map((t) => t.userId);
  const cleanupReport: Record<string, unknown> = {};

  // Module 11 rows first (ai_runs may have been written by the PARTIAL
  // eligibility test, which legitimately succeeds).
  for (const table of ['ai_runs', 'ai_usage_ledger', 'ai_answer_cache', 'ai_insights', 'ai_recommendations', 'ai_feedback']) {
    for (const id of ids) await admin.from(table).delete().eq('user_id', id);
  }
  // Canonical rows, then the auth users themselves (cascades the rest).
  for (const table of ['income_sources', 'expense_items', 'assets', 'liabilities', 'financial_snapshots', 'households', 'user_profiles']) {
    for (const id of ids) await admin.from(table).delete().eq('user_id', id);
  }
  for (const id of ids) await admin.auth.admin.deleteUser(id);

  // Independent post-cleanup verification.
  for (const table of ['ai_runs', 'ai_usage_ledger', 'ai_insights', 'ai_recommendations', 'ai_feedback', 'income_sources', 'expense_items', 'assets', 'liabilities', 'financial_snapshots', 'user_profiles']) {
    let remaining = 0;
    for (const id of ids) {
      const { data } = await admin.from(table).select('user_id').eq('user_id', id);
      remaining += (data ?? []).length;
    }
    cleanupReport[table] = remaining;
  }
  let usersRemaining = 0;
  for (const id of ids) {
    const { data } = await admin.auth.admin.getUserById(id);
    if (data?.user) usersRemaining++;
  }
  cleanupReport.auth_users = usersRemaining;
  cleanupReport.forged_prompt_rows = ((await admin.from('ai_prompt_templates').select('id').like('prompt_code', 'FORGED-%')).data ?? []).length;

  fs.writeFileSync(path.join(repoRoot, 'test-artifacts', 'module11-residual-live-cleanup.json'), JSON.stringify(cleanupReport, null, 2));
  const residue = Object.entries(cleanupReport).filter(([, v]) => (v as number) !== 0);
  if (residue.length > 0) throw new Error(`CLEANUP FAILED — residue: ${JSON.stringify(residue)}`);
});
