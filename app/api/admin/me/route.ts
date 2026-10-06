import { ok } from '@/lib/api';
import {
  getCurrentResourceRoles,
  canViewResourceDashboard,
  canViewResourceContent,
  canViewResourceWorkflow,
  canViewResourceDiscovery,
  canViewResourceAnalytics,
} from '@/lib/resources/permissions';
import { createClient } from '@/lib/supabase/server';
import { PC6_ADMIN_CAPABILITY } from '@/lib/services/investment-intelligence/pc6/referenceDataAdmin';
import { PC7_ADMIN_CAPABILITY } from '@/lib/services/investment-intelligence/pc7/lookthroughDataAdmin';
import { MARKET_INDEX_ADMIN_CAPABILITY } from '@/lib/services/investment-intelligence/marketIndex/marketIndexAdmin';
import { BENCHMARK_CAPABILITY_COLUMNS, BENCHMARK_VIEW_COLUMN, flagsFromAdminRow, NO_BENCHMARK_CAPABILITIES, type BenchmarkCapabilityFlags } from '@/lib/services/investment-intelligence/benchmarkData/guards';
import { PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY } from '@/lib/services/premiumEntitlementAdmin';
import { PROMO_CODE_ADMIN_CAPABILITY } from '@/lib/services/promoCodeAdmin';
import { PLANNING_BENCHMARK_CAPABILITY_COLUMNS, planningBenchmarkFlagsFromRow, NO_PLANNING_BENCHMARK_CAPABILITIES, type PlanningBenchmarkFlags } from '@/lib/planning-benchmarks/guards';

/**
 * PC6/N.11. The reference-data capability lives on admin_users, not on
 * resource_user_roles, so it cannot be read from the Resources role snapshot
 * above. It gets its own independent read — the route's own rule that each
 * capability is a separately named evaluation, never a shared boolean.
 *
 * FAILS CLOSED: any error, a logged-out caller, or a missing row yields false.
 * Consistent with this route's "never a 403" contract — it reports the absence
 * of a capability rather than refusing.
 */
async function canViewReferenceDataQuality(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase
      .from('admin_users')
      .select(PC6_ADMIN_CAPABILITY)
      .eq('user_id', user.id)
      .maybeSingle();
    return data?.[PC6_ADMIN_CAPABILITY] === true;
  } catch {
    return false;
  }
}

/**
 * PC7/O.9 — the Underlying Fund Holdings quality capability.
 *
 * A SEPARATE read from the PC6 one, deliberately. Deriving it from
 * canViewReferenceDataQuality() would make one grant silently confer the
 * other, which is precisely the capability-implication Standard §2 prohibits.
 *
 * FAILS CLOSED: any error, a logged-out caller, or a missing row yields false.
 * A missing COLUMN (migration 0157 not yet applied) also yields false, which
 * is the correct fail-closed answer — an unapplied migration must not become a
 * grant.
 */
async function canViewLookthroughDataQuality(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase
      .from('admin_users')
      .select(PC7_ADMIN_CAPABILITY)
      .eq('user_id', user.id)
      .maybeSingle();
    return data?.[PC7_ADMIN_CAPABILITY] === true;
  } catch {
    return false;
  }
}

/**
 * Market Index Data upload capability (migration 0232). Its own independent
 * read — never derived from the PC6/PC7 reads above or from isAdmin: this
 * capability WRITES data, those only read (Standard section 2).
 *
 * FAILS CLOSED: any error, a logged-out caller, a missing row or a missing
 * COLUMN (0232 not applied) yields false.
 */
async function canUploadMarketIndexData(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase
      .from('admin_users')
      .select(MARKET_INDEX_ADMIN_CAPABILITY)
      .eq('user_id', user.id)
      .maybeSingle();
    return (data as unknown as Record<string, unknown> | null)?.[MARKET_INDEX_ADMIN_CAPABILITY] === true;
  } catch {
    return false;
  }
}


/**
 * Admin Premium grant (migration 0231) — the entitlement-management capability.
 *
 * Its own independent read, deliberately not derived from any other capability
 * or from Super Admin (Standard §2/§3). FAILS CLOSED: any error, a logged-out
 * caller, a missing row or a missing COLUMN (migration not yet applied) yields
 * false — an unapplied migration must never become a grant.
 */
async function canManagePremiumEntitlements(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase
      .from('admin_users')
      .select(PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY)
      .eq('user_id', user.id)
      .maybeSingle();
    return data?.[PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY] === true;
  } catch {
    return false;
  }
}

/**
 * Promo codes (migration 0237) — its own independent read, NOT derived from
 * entitlementManagement or Super Admin (Standard §2/§3). Fails closed.
 */
async function canManagePromoCodes(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase
      .from('admin_users')
      .select(PROMO_CODE_ADMIN_CAPABILITY)
      .eq('user_id', user.id)
      .maybeSingle();
    return data?.[PROMO_CODE_ADMIN_CAPABILITY] === true;
  } catch {
    return false;
  }
}

/**
 * BENCH-1 Phase 2 (migration 0241) - the benchmark-data capabilities. ONE admin_users read, but each
 * output field is its own === true evaluation of its own column (flagsFromAdminRow): no flag is derived
 * from another except `view`, which is the union of READ access only.
 *
 * FAILS CLOSED: any error, a logged-out caller, a missing row or a missing COLUMN (0241 not applied)
 * yields all-false.
 */
async function readBenchmarkCapabilities(): Promise<BenchmarkCapabilityFlags> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ...NO_BENCHMARK_CAPABILITIES };
    const { data, error } = await supabase
      .from('admin_users')
      .select([BENCHMARK_VIEW_COLUMN, ...Object.values(BENCHMARK_CAPABILITY_COLUMNS)].join(', '))
      .eq('user_id', user.id)
      .maybeSingle();
    if (error || !data) return { ...NO_BENCHMARK_CAPABILITIES };
    return flagsFromAdminRow(data as unknown as Record<string, unknown>);
  } catch {
    return { ...NO_BENCHMARK_CAPABILITIES };
  }
}

/**
 * Planning Benchmarks staged upload (migration 0270) - the two separately named capabilities. ONE admin_users
 * read, but each output field is its own === true evaluation of its own column. FAILS CLOSED: any error, a
 * logged-out caller, a missing row or a missing COLUMN (0270 not applied) yields all-false.
 */
async function readPlanningBenchmarkCapabilities(): Promise<PlanningBenchmarkFlags> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ...NO_PLANNING_BENCHMARK_CAPABILITIES };
    const { data, error } = await supabase
      .from('admin_users')
      .select(Object.values(PLANNING_BENCHMARK_CAPABILITY_COLUMNS).join(', '))
      .eq('user_id', user.id)
      .maybeSingle();
    if (error || !data) return { ...NO_PLANNING_BENCHMARK_CAPABILITIES };
    return planningBenchmarkFlagsFromRow(data as unknown as Record<string, unknown>);
  } catch {
    return { ...NO_PLANNING_BENCHMARK_CAPABILITIES };
  }
}

// Lets the nav know which Admin groups to show, without exposing any admin
// data itself — a logged-out, non-admin, non-Resources-role caller just gets
// all-false flags, never a 403 (the actual admin/Resources routes still
// enforce their own server-side checks — this is UX-only gating per spec
// §90: "Navigation hiding is only UX", RLS remains the real boundary; see
// also Admin Architecture Standard §4).
//
// Phase A Wave 1 (Final Corrective Addendum §1.6, Second Corrective Addendum
// §1.3): this route used to re-implement, inline, the same
// admin_users + resource_user_roles lookup that getCurrentResourceRoles()
// already performs as the one canonical, shared role-resolution path every
// other Resources route calls — with `.limit(1)`, an existence-only check
// that structurally cannot answer "does the caller hold THIS role". Both the
// drift risk and that structural incapacity are removed here: the shared
// helper is called exactly once per request, and all five capabilities are
// pure evaluations over that single role snapshot.
//
// Each capability is its own separately named predicate call, never one
// shared boolean copied across fields (Standard §2) — four of the five
// resolve to the same underlying check today, but a future change to one
// destination's requirement touches only that destination's predicate.
//
// Mandatory Country Confirmation, round-2 closure (MCC-2): deliberately the
// ONE admin API route NOT wired to countryConfirmationBlockResponse. Its own
// documented contract is "never a 403" — it always returns a safe boolean
// pair, even for a logged-out caller — and blocking it would both violate
// that contract and be moot in practice: a country-unconfirmed user is
// already redirected away from every app/(app)/** page (including the ones
// that would call this) by app/(app)/layout.tsx before this endpoint could
// ever be reached from the real UI. Every route this endpoint's flags are
// used to decide whether to *link to* is itself independently gated (the 54
// other admin routes, closed this round; the admin pages, closed in round
// 1) — so a forged/unconfirmed caller of this specific endpoint learns
// nothing exploitable, only whether admin_users/resource_user_roles rows
// exist for their own id, which they could already read directly under RLS.
export async function GET() {
  const current = await getCurrentResourceRoles();
  const benchmark = await readBenchmarkCapabilities();
  const planning = await readPlanningBenchmarkCapabilities();
  return ok({
    // Unchanged legacy fields, kept for existing consumers. Neither is used
    // to derive any capability below.
    isAdmin: current.isSuperAdmin,
    hasResourcesAccess: current.isSuperAdmin || current.roles.length > 0,
    capabilities: {
      resourcesDashboard: canViewResourceDashboard(current),
      resourceContentAdmin: canViewResourceContent(current),
      resourceWorkflowAdmin: canViewResourceWorkflow(current),
      resourceDiscoveryAdmin: canViewResourceDiscovery(current),
      resourceAnalytics: canViewResourceAnalytics(current),
      referenceDataQuality: await canViewReferenceDataQuality(),
      lookthroughDataQuality: await canViewLookthroughDataQuality(),
      marketIndexDataUpload: await canUploadMarketIndexData(),
      benchmarkDataView: benchmark.view,
      benchmarkDataPublish: benchmark.publish,
      benchmarkDataCorrect: benchmark.correct,
      benchmarkCatalogueManage: benchmark.catalogue,
      benchmarkEntitlementApprove: benchmark.entitlementApprove,
      entitlementManagement: await canManagePremiumEntitlements(),
      promoCodeManagement: await canManagePromoCodes(),
      planningBenchmarkUpload: planning.upload,
      planningBenchmarkActivate: planning.activate,
    },
  });
}
