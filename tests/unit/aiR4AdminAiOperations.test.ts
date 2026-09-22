// Module 11 remediation R4 — Admin AI Operations: Admin Architecture
// Standard compliance evidence (§2 positive/negative per capability, §4
// direct-API / direct-URL / database-bypass, §8 result states, §9 no
// identifiers, §13 fail closed) plus the extended kill-switch contract.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// A. Capability guards (API + page layers) with a scripted session/DB.
// ---------------------------------------------------------------------------
let sessionUser: { id: string } | null = { id: 'admin-1' };
let adminRow: Record<string, unknown> | null = { can_view_ai_operations: true, can_manage_ai_operations: false };
let adminRowError: { message: string } | null = null;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: adminRow, error: adminRowError }) }) }) }),
  }),
}));
vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));
const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); });
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const guards = await import('@/lib/services/aiOperationsAdmin');

beforeEach(() => { sessionUser = { id: 'admin-1' }; adminRow = { can_view_ai_operations: true, can_manage_ai_operations: false }; adminRowError = null; redirect.mockClear(); });

describe('R4 §2/§4/§13 — capability guards', () => {
  it('viewer: 401 with no session; 403 without the column; 403 on a DB error (unapplied 0177); pass with the column', async () => {
    sessionUser = null;
    expect((await guards.requireAiOperationsViewer()).forbidden?.status).toBe(401);
    sessionUser = { id: 'admin-1' }; adminRow = { can_view_ai_operations: false };
    expect((await guards.requireAiOperationsViewer()).forbidden?.status).toBe(403);
    adminRow = null; // present in admin_users? no row at all
    expect((await guards.requireAiOperationsViewer()).forbidden?.status).toBe(403);
    adminRow = { can_view_ai_operations: true }; adminRowError = { message: 'column "can_view_ai_operations" does not exist' };
    expect((await guards.requireAiOperationsViewer()).forbidden?.status).toBe(403);
    adminRowError = null;
    const okResult = await guards.requireAiOperationsViewer();
    expect(okResult.forbidden).toBeNull();
    expect(okResult.user?.id).toBe('admin-1');
  });

  it('manager is a SEPARATE capability: a viewer without manage is 403 on the manage guard, and vice versa', async () => {
    adminRow = { can_view_ai_operations: true, can_manage_ai_operations: false };
    expect((await guards.requireAiOperationsManager()).forbidden?.status).toBe(403);
    adminRow = { can_view_ai_operations: false, can_manage_ai_operations: true };
    expect((await guards.requireAiOperationsViewer()).forbidden?.status).toBe(403);
    expect((await guards.requireAiOperationsManager()).forbidden).toBeNull();
  });

  it('a truthy-but-not-boolean column value never grants (strict === true)', async () => {
    adminRow = { can_view_ai_operations: 'yes' };
    expect((await guards.requireAiOperationsViewer()).forbidden?.status).toBe(403);
  });

  it('page guard (§4 layer 3): no session -> /login; no capability -> /dashboard; never renders empty', async () => {
    sessionUser = null;
    await expect(guards.requireAiOperationsViewerPage()).rejects.toThrow('REDIRECT:/login');
    sessionUser = { id: 'u' }; adminRow = { can_view_ai_operations: false };
    await expect(guards.requireAiOperationsViewerPage()).rejects.toThrow('REDIRECT:/dashboard');
    adminRow = { can_view_ai_operations: true };
    expect((await guards.requireAiOperationsViewerPage()).id).toBe('u');
  });

  it('/api/admin/me helper fails closed to all-false and never throws', async () => {
    adminRowError = { message: 'boom' };
    expect(await guards.readAiOperationsCapabilities()).toEqual({ aiOperations: false, aiOperationsManage: false });
    adminRowError = null; adminRow = { can_view_ai_operations: true, can_manage_ai_operations: true };
    expect(await guards.readAiOperationsCapabilities()).toEqual({ aiOperations: true, aiOperationsManage: true });
  });
});

// ---------------------------------------------------------------------------
// B. Direct-API denial through the real route handlers (§4).
// ---------------------------------------------------------------------------
describe('R4 §4 — direct API calls are denied explicitly, never answered with empty data', () => {
  it('GET /api/admin/ai/operations -> 403 for a caller without the capability, and the overview builder is never invoked', async () => {
    vi.doMock('@/lib/ai/admin/aiOperationsOverview', () => ({ buildAiOperationsOverview: vi.fn(async () => { throw new Error('must not be called'); }) }));
    const { GET } = await import('@/app/api/admin/ai/operations/route');
    adminRow = { can_view_ai_operations: false };
    const res = await GET(new Request('http://x/api/admin/ai/operations'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('access required') });
    vi.doUnmock('@/lib/ai/admin/aiOperationsOverview');
  });

  it('POST /api/admin/ai/insight-packs/scheduler/run -> 403 without manage; with manage but not Super Admin -> 403 from requireAdmin; scheduler never constructed', async () => {
    const created = vi.fn();
    vi.doMock('@/lib/ai/insightPack/scheduler', () => ({ createSchedulerService: () => { created(); return {}; }, getModule11SchedulerMaxHouseholdsPerRun: () => 5 }));
    vi.doMock('@/lib/services/adminAuth', () => ({ adminRoute: (h: (...a: unknown[]) => Promise<Response>) => h, requireAdmin: async () => ({ user: null, forbidden: new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 }) }) }));
    const { POST } = await import('@/app/api/admin/ai/insight-packs/scheduler/run/route');
    adminRow = { can_manage_ai_operations: false };
    expect((await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ phase: 'submit', dryRun: true }) }))).status).toBe(403);
    adminRow = { can_manage_ai_operations: true };
    expect((await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ phase: 'submit', dryRun: true }) }))).status).toBe(403);
    expect(created).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/ai/insightPack/scheduler'); vi.doUnmock('@/lib/services/adminAuth');
  });
});

// ---------------------------------------------------------------------------
// C. Overview service: §8 result states, §9 no identifiers, §7 suppression.
// ---------------------------------------------------------------------------
describe('R4 §8/§9 — overview result states and privacy', () => {
  it('a source that cannot be read is `unavailable` WITH a reason (never a healthy zero); spend distribution is suppressed below 10 subjects; payload carries no user ids', async () => {
    vi.resetModules();
    const perUser = Array.from({ length: 7 }, (_, i) => ({ user_id: `user-${i}`, billing_period: '2026-09', custom_question_count: 1, refunded_question_count: 0, cached_answer_count: 0, live_call_count: 1, estimated_cost_usd: 0.05 * (i + 1) }));
    vi.doMock('@/lib/ai/entitlement/platformControls', () => ({
      buildUsageDashboard: async () => ({ billing_period: '2026-09', entitled_subjects: 12, subjects_with_usage: 7, subjects_at_quota: 0, custom_questions_used: 7, custom_questions_refunded: 0, cached_answers_served: 0, live_calls: 7, input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, estimated_cost_usd: 1.4, actual_cost_usd: null, average_cost_per_entitled_subject_usd: 0.11, projected_period_end_cost_usd: 2, denials_by_reason: { rate_limited: 2 }, events_by_severity: {}, provider_executions: 7, provider_failures: 0, kill_switch_state: null }),
      getPlatformControls: async () => ({ id: 'global', ai_globally_enabled: true }),
      listProviderControls: async () => [],
      listTaskCostLimits: async () => [],
      listConfigAudit: async () => [],
      listOperationalEvents: async () => [{ id: 'e1', event_type: 'kill_switch_blocked', severity: 'HIGH', user_id: 'user-secret', billing_period: '2026-09', task_type: 'x', provider: 'openai', model: 'm', admission_id: 'adm', detail: 'blocked', metadata: { user_id: 'user-secret' }, created_at: '2026-09-22T00:00:00Z' }],
      summariseUsageForPeriod: async () => ({ perUser, platformEstimatedCostUsd: 1.4, platformCustomQuestionCount: 7 }),
    }));
    vi.doMock('@/lib/ai/modelRegistry', () => ({ listModelRegistry: async () => [] }));
    vi.doMock('@/lib/ai/promptRegistry', () => ({ listPromptTemplates: async () => [] }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: (table: string) => {
          const chain = {
            select: () => chain, eq: () => chain, gte: () => chain, order: () => chain, limit: () => chain, in: () => chain,
            maybeSingle: async () => (table === 'ai_platform_controls' ? { data: { scheduler_enabled: false }, error: null } : { data: null, error: null }),
            then: (resolve: (v: unknown) => void) => resolve(table === 'ai_insight_pack_scheduler_jobs' ? { data: null, error: { message: 'relation "ai_insight_pack_scheduler_jobs" does not exist' } } : { data: [], error: null, count: 0 }),
          };
          return chain;
        },
      }),
    }));
    const { buildAiOperationsOverview, MIN_DISTINCT_SUBJECTS } = await import('@/lib/ai/admin/aiOperationsOverview');
    const o = await buildAiOperationsOverview('2026-09');
    expect(o.scheduler.state).toBe('unavailable');
    expect(o.scheduler.reason).toContain('does not exist');
    expect(o.spend_distribution.state).toBe('suppressed');
    expect(o.spend_distribution.reason).toContain('Insufficient data to display safely');
    expect(perUser.length).toBeLessThan(MIN_DISTINCT_SUBJECTS);
    expect(o.usage.state).toBe('ok');
    expect(o.usage.data?.denials_by_reason.rate_limited).toBe(2);
    expect(o.safety.state).toBe('ok');
    expect(o.safety.data?.recent_high[0]).not.toHaveProperty('user_id');
    // §9: no user identifier anywhere in the serialised payload.
    expect(JSON.stringify(o)).not.toMatch(/user-secret|user-\d|"user_id"|admission_id/);
    vi.doUnmock('@/lib/ai/entitlement/platformControls'); vi.doUnmock('@/lib/ai/modelRegistry'); vi.doUnmock('@/lib/ai/promptRegistry'); vi.doUnmock('@/lib/supabase/admin');
  });

  it('spend distribution with >= 10 subjects yields bands each >= 5 (small cells merged), a median, and no per-subject maximum', async () => {
    vi.resetModules();
    const perUser = Array.from({ length: 14 }, (_, i) => ({ user_id: `u${i}`, billing_period: '2026-09', custom_question_count: 0, refunded_question_count: 0, cached_answer_count: 0, live_call_count: 0, estimated_cost_usd: i < 9 ? 0.05 : i < 13 ? 0.7 : 4.0 }));
    vi.doMock('@/lib/ai/entitlement/platformControls', () => ({
      buildUsageDashboard: async () => { throw new Error('ledger down'); },
      getPlatformControls: async () => null,
      listProviderControls: async () => [], listTaskCostLimits: async () => [], listConfigAudit: async () => [], listOperationalEvents: async () => [],
      summariseUsageForPeriod: async () => ({ perUser, platformEstimatedCostUsd: 0, platformCustomQuestionCount: 0 }),
    }));
    vi.doMock('@/lib/ai/modelRegistry', () => ({ listModelRegistry: async () => [] }));
    vi.doMock('@/lib/ai/promptRegistry', () => ({ listPromptTemplates: async () => [] }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => { const c = { select: () => c, eq: () => c, gte: () => c, order: () => c, limit: () => c, in: () => c, maybeSingle: async () => ({ data: null, error: null }), then: (r: (v: unknown) => void) => r({ data: [], error: null, count: 0 }) }; return c; } }) }));
    const { buildAiOperationsOverview } = await import('@/lib/ai/admin/aiOperationsOverview');
    const o = await buildAiOperationsOverview('2026-09');
    expect(o.usage.state).toBe('unavailable');
    expect(o.usage.reason).toBe('ledger down');
    expect(o.controls.state).toBe('unavailable');
    expect(o.spend_distribution.state).toBe('ok');
    const d = o.spend_distribution.data!;
    expect(d.subjects_with_spend).toBe(14);
    expect(d.bands.every((b) => b.count >= 5)).toBe(true);
    expect(d.bands.reduce((a, b) => a + b.count, 0)).toBe(14);
    expect(d).not.toHaveProperty('max_subject_spend_usd');
    vi.doUnmock('@/lib/ai/entitlement/platformControls'); vi.doUnmock('@/lib/ai/modelRegistry'); vi.doUnmock('@/lib/ai/promptRegistry'); vi.doUnmock('@/lib/supabase/admin');
  });
});

// ---------------------------------------------------------------------------
// D. Database layer (§4 layer 1) and the 0177 predicates, in real Postgres.
// ---------------------------------------------------------------------------
describe('R4 §4 layer 1 — database-bypass proof (PGlite, real migration chain incl. 0177)', () => {
  it('an authenticated (non-service) session reads ZERO rows from every AI governance table, and the capability predicates are false without the column', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..', '..');
    const db = await PGlite.create();
    await db.exec(fs.readFileSync(path.join(root, 'scripts/db-rebuild-check/shim.sql'), 'utf8'));
    const migDir = path.join(root, 'supabase/migrations');
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
      if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(root, 'supabase/seed.sql'), 'utf8'));
    }
    const ADMIN = '55555555-5555-5555-5555-000000000001';
    await db.exec(`insert into auth.users(id,email) values ('${ADMIN}','r4-admin@example.test'); insert into admin_users(user_id) values ('${ADMIN}') on conflict do nothing;`);
    // Simulate the admin's own session: auth.uid() = ADMIN, role authenticated.
    await db.exec(`grant usage on schema public to authenticated; grant select on all tables in schema public to authenticated;`);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
    const pred = await db.query(`select is_ai_operations_viewer() v, is_ai_operations_manager() m`);
    expect(pred.rows[0]).toEqual({ v: false, m: false }); // membership in admin_users alone grants nothing
    for (const t of ['ai_platform_controls', 'ai_model_registry', 'ai_provider_controls', 'ai_usage_ledger', 'ai_runs', 'ai_config_audit', 'ai_insight_pack_batches', 'ai_insight_pack_scheduler_runs', 'ai_insight_pack_scheduler_jobs']) {
      const { rows } = await db.query(`select count(*)::int n from ${t}`);
      expect((rows[0] as { n: number }).n, `${t} must be invisible to a user session`).toBe(0);
    }
    // The scheduler lease RPC is revoked from authenticated.
    await expect(db.query(`select ai_insight_pack_scheduler_claim('submit','admin','2026-09',60,true)`)).rejects.toThrow(/permission denied/);
    await db.exec(`reset role;`);
    await db.exec(`update admin_users set can_view_ai_operations=true where user_id='${ADMIN}'`);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
    const pred2 = await db.query(`select is_ai_operations_viewer() v, is_ai_operations_manager() m`);
    expect(pred2.rows[0]).toEqual({ v: true, m: false }); // view does not imply manage
    await db.exec(`reset role;`);
    await db.close();
  }, 180_000);
});

afterAll(() => { vi.resetModules(); });
