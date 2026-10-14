// Fund analytics health -- the aggregate-only NAV2 monitoring snapshot (migration 0262).
//
// ADMIN ARCHITECTURE STANDARD -- applicability, stated:
//   Capability  : the existing PC6 referenceDataQuality capability (admin_users.can_view_reference_data_quality). This is a
//                 read-only health view of that same surface (NAV freshness, hydration, corrections, storage), so no new
//                 capability is created (s2). It does NOT confer risk-free upload or switch, nor the reverse.
//   Four layers : (1) DB -- nav2_monitoring_snapshot() authorises INSIDE with is_pc6_reference_data_admin() and raises 42501
//                            otherwise; (2) API -- requireReferenceDataAdmin() below; (3) page -- requireReferenceDataAdminPage();
//                 (4) nav -- lib/admin/adminNav.ts (Reference Data group).
//   s7 / s9     : the snapshot counts things derived from user holdings. EVERY such figure is suppressed below 5 by the
//                 database function (state `suppressed`, label "Insufficient data to display safely."); an absent source is
//                 `unavailable`, never a bare 0. No user identifier, no holding, no name leaves the database function.
//   s8          : the function returns per-cell {state, value, label}; this route passes it through unchanged.
//   s13         : an unapplied migration, an authorisation refusal or an error is an explicit status, never an empty success.
//
// Runs under the CALLER'S OWN session client (never the service client): the database function authorises with auth.uid().
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { requireReferenceDataAdmin } from '@/lib/services/investment-intelligence/pc6/referenceDataAdmin';

export const dynamic = 'force-dynamic';

const UNAVAILABLE_0262 = 'Migration 0262 has not been applied to this database, so the monitoring snapshot does not exist yet. This is reported as unavailable rather than as a healthy empty state.';

const UNAVAILABLE_0282 = 'Migration 0282 has not been applied to this database, so the count of statement lines held back for review (ISIN and AMFI code disagree) does not exist yet. This is reported as unavailable rather than as zero.';

const UNAVAILABLE_0263 = 'Migration 0263 has not been applied to this database, so the weekly refresh attempt summary does not exist yet. This is reported as unavailable rather than as zero.';

export const GET = adminRoute(async () => {
  const { user, forbidden } = await requireReferenceDataAdmin();
  if (forbidden || !user) return forbidden ?? bad('unauthenticated', 401);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('nav2_monitoring_snapshot');
  if (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === '42501') return bad('Reference-data admin access required', 403);
    if (code === '42883' || code === 'PGRST202' || /could not find the function|does not exist/i.test(error.message ?? '')) return ok({ state: 'unavailable', reason: UNAVAILABLE_0262 });
    console.error('nav2 monitoring snapshot error:', error);
    return bad('The monitoring snapshot could not be read.', 500);
  }
  // The weekly RBI refresh's attempt summary (migration 0263): robots.txt unavailable count, blocked-by-source count, last attempt.
  // A missing function (0263 not applied) is `unavailable`, never an error and never a healthy zero.
  const attempts = await supabase.rpc('nav2_refresh_attempt_summary');
  let refreshAttempts: { state: 'ok'; value: unknown } | { state: 'unavailable'; reason: string };
  if (attempts.error) {
    const code = (attempts.error as { code?: string }).code ?? '';
    if (code === '42501') return bad('Reference-data admin access required', 403);
    refreshAttempts = { state: 'unavailable', reason: UNAVAILABLE_0263 };
  } else refreshAttempts = { state: 'ok', value: attempts.data };
  // NAV2-F1 monitoring (migration 0282): new review questions opened because a statement line's ISIN and AMFI code point at different funds.
  // Aggregate-only, every figure suppressed below 5 inside the function. A missing function is `unavailable`, never a healthy zero.
  const ambiguity = await supabase.rpc('nav2_ambiguity_case_summary');
  let identifierConflicts: { state: 'ok'; value: unknown } | { state: 'unavailable'; reason: string };
  if (ambiguity.error) {
    const code = (ambiguity.error as { code?: string }).code ?? '';
    if (code === '42501') return bad('Reference-data admin access required', 403);
    identifierConflicts = { state: 'unavailable', reason: UNAVAILABLE_0282 };
  } else identifierConflicts = { state: 'ok', value: ambiguity.data };
  return ok({ state: 'ok', snapshot: data, refreshAttempts, identifierConflicts });
});
