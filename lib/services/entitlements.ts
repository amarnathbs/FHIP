import { createClient } from '@/lib/supabase/server';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { effectivePlanTier, utcToday } from '@/lib/services/entitlementWindow';

export type PlanTier = 'free' | 'premium';

// Every user starts on 'free' (seeded by migration + signup trigger).
// LR-10 added a real billing integration (Stripe for AU, Razorpay for IN —
// see lib/services/payments/) that upgrades plan_tier here via its own
// webhook-verified entitlementSync.ts, never directly — this function's own
// read stays exactly as simple as before, it just now has a real writer
// behind it instead of none.
//
// Accepts an optional pre-built client — without this, the scheduled
// monthly-report cron job (app/api/reports/cron/monthly-generate/route.ts,
// which authenticates via a shared secret with no user session/cookies to
// build a server client from) crashed on every single user with "cookies
// was called outside a request scope", silently failing every scheduled
// report generation (caught by that route's per-user try/catch, so the
// route itself returned 200 while every result underneath was 'error').
// Found via the FHIP 50-User E2E test cycle's Phase 5 report generation,
// reproduced directly against generateReport({..., client: <service-role>}).
//
// Admin Premium grant (migration 0231): this now honours the entitlement
// validity window (effective_from / effective_to) exactly like the AI SQL
// functions do (migration 0115). Before, it returned the bare stored flag, so
// a time-limited entitlement (an admin grant) that had lapsed would still have
// unlocked report export, Premium report content and the Premium recommendation
// list indefinitely. The rule lives in entitlementWindow.ts so there is one
// definition of "Premium today" for the TypeScript consumers.
export async function getPlanTier(userId: string, client?: SupabaseServerClient): Promise<PlanTier> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('user_entitlements')
    .select('plan_tier, effective_from, effective_to')
    .eq('user_id', userId)
    .maybeSingle();
  return effectivePlanTier(data as { plan_tier?: string | null; effective_from?: string | null; effective_to?: string | null } | null, utcToday());
}

export async function canExportReports(userId: string, client?: SupabaseServerClient): Promise<boolean> {
  return (await getPlanTier(userId, client)) === 'premium';
}

// Kept as its own function (not an alias of canExportReports) since report
// content access and export-format access may diverge later (e.g. a future
// tier that can view Premium content but not export it).
export async function canViewPremiumReport(userId: string, client?: SupabaseServerClient): Promise<boolean> {
  return (await getPlanTier(userId, client)) === 'premium';
}
