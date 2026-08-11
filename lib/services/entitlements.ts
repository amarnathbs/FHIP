import { createClient } from '@/lib/supabase/server';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';

export type PlanTier = 'free' | 'premium';

// No billing/subscription system exists yet — this is a minimal stand-in.
// Every user starts on 'free' (seeded by migration + signup trigger); there
// is no self-service upgrade path until a real billing integration exists.
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
export async function getPlanTier(userId: string, client?: SupabaseServerClient): Promise<PlanTier> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase.from('user_entitlements').select('plan_tier').eq('user_id', userId).maybeSingle();
  return (data?.plan_tier as PlanTier) ?? 'free';
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
