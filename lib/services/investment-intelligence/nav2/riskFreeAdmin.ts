// Capability guards for the Risk-free Rate Data admin surface (NAV2 Stage 2).
//
// ADMIN ARCHITECTURE STANDARD SECTION 2. Two SEPARATELY-NAMED capabilities, each backed by its own column on
// admin_users (migration 0260), read fresh on every call, and neither implies the other, Super Admin, or any other
// capability (market-index, PC6 reference-data-quality, benchmark data, entitlements):
//
//   upload  admin_users.can_upload_risk_free_data         upload a CSV, resolve a review item, correct a value
//   switch  admin_users.can_switch_risk_free_series       switch a series on/off, change its terms status
//
// The switch is separate on purpose (Standard section 3, separation of duties): the person who loads the data is not
// thereby the person who can switch the series that feeds every customer's Sharpe / Sortino / alpha on or off.
//
// SECTION 4 -- all four layers, each enforced independently:
//   1. database  : is_risk_free_data_admin() / is_risk_free_series_switch_admin(), each RPC's own auth.uid() check, RLS
//   2. API       : requireRiskFreeCapability()            (this file; explicit 401/403 on EVERY verb)
//   3. page      : requireRiskFreePage()                  (this file; redirect before any render)
//   4. navigation: lib/admin/adminNav.ts riskFreeDataUpload / riskFreeSeriesSwitch
// SECTION 13: a read error, a missing row or a missing COLUMN (migration 0260 not applied) is a denial, never a grant.
import { redirect } from 'next/navigation';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export const RISK_FREE_UPLOAD_CAPABILITY = 'can_upload_risk_free_data' as const;
export const RISK_FREE_SWITCH_CAPABILITY = 'can_switch_risk_free_series' as const;

export type RiskFreeCapabilityKind = 'upload' | 'switch';
const COLUMN: Record<RiskFreeCapabilityKind, string> = { upload: RISK_FREE_UPLOAD_CAPABILITY, switch: RISK_FREE_SWITCH_CAPABILITY };

export interface RiskFreeCapabilityFlags {
  upload: boolean;
  switch: boolean;
}
export const NO_RISK_FREE_CAPABILITIES: RiskFreeCapabilityFlags = Object.freeze({ upload: false, switch: false });

/** Each flag is its own strict `=== true` evaluation of its own column; neither is derived from the other. */
export function riskFreeFlagsFromRow(row: Record<string, unknown> | null | undefined): RiskFreeCapabilityFlags {
  if (!row) return { ...NO_RISK_FREE_CAPABILITIES };
  return { upload: row[RISK_FREE_UPLOAD_CAPABILITY] === true, switch: row[RISK_FREE_SWITCH_CAPABILITY] === true };
}

/** One admin_users read for BOTH columns (so a half-applied migration fails closed for both). Never throws. */
export async function readRiskFreeCapabilityFlags(supabase: SupabaseClient, userId: string): Promise<RiskFreeCapabilityFlags> {
  try {
    const { data, error } = await supabase.from('admin_users').select(`${RISK_FREE_UPLOAD_CAPABILITY}, ${RISK_FREE_SWITCH_CAPABILITY}`).eq('user_id', userId).maybeSingle();
    if (error || !data) return { ...NO_RISK_FREE_CAPABILITIES };
    return riskFreeFlagsFromRow(data as unknown as Record<string, unknown>);
  } catch {
    return { ...NO_RISK_FREE_CAPABILITIES };
  }
}

/** API-layer guard. `kind` 'any' admits a holder of either capability (read-only status). */
export async function requireRiskFreeCapability(kind: RiskFreeCapabilityKind | 'any'): Promise<{ user: User | null; flags: RiskFreeCapabilityFlags; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, flags: { ...NO_RISK_FREE_CAPABILITIES }, forbidden: bad('unauthenticated', 401) };

  const flags = await readRiskFreeCapabilityFlags(supabase as unknown as SupabaseClient, user.id);
  const allowed = kind === 'any' ? flags.upload || flags.switch : flags[kind];
  if (!allowed) return { user: null, flags, forbidden: bad(kind === 'switch' ? 'Risk-free series switch access required' : kind === 'upload' ? 'Risk-free data upload access required' : 'Risk-free data admin access required', 403) };

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, flags, forbidden: countryBlock };
  return { user, flags, forbidden: null };
}

/** Page-layer guard (section 4 layer 3): a disallowed direct navigation is redirected, never shown an empty screen. */
export async function requireRiskFreePage(kind: RiskFreeCapabilityKind | 'any' = 'any'): Promise<{ user: User; flags: RiskFreeCapabilityFlags }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const flags = await readRiskFreeCapabilityFlags(supabase as unknown as SupabaseClient, user.id);
  const allowed = kind === 'any' ? flags.upload || flags.switch : flags[kind];
  if (!allowed) redirect('/dashboard');
  return { user, flags };
}

export { COLUMN as RISK_FREE_CAPABILITY_COLUMNS };
