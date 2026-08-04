import { createClient } from '@/lib/supabase/server';

export type PlanTier = 'free' | 'premium';

// No billing/subscription system exists yet — this is a minimal stand-in.
// Every user starts on 'free' (seeded by migration + signup trigger); there
// is no self-service upgrade path until a real billing integration exists.
export async function getPlanTier(userId: string): Promise<PlanTier> {
  const supabase = await createClient();
  const { data } = await supabase.from('user_entitlements').select('plan_tier').eq('user_id', userId).maybeSingle();
  return (data?.plan_tier as PlanTier) ?? 'free';
}

export async function canExportReports(userId: string): Promise<boolean> {
  return (await getPlanTier(userId)) === 'premium';
}

// Kept as its own function (not an alias of canExportReports) since report
// content access and export-format access may diverge later (e.g. a future
// tier that can view Premium content but not export it).
export async function canViewPremiumReport(userId: string): Promise<boolean> {
  return (await getPlanTier(userId)) === 'premium';
}
