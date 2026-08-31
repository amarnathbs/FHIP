import { ok } from '@/lib/api';
import {
  getCurrentResourceRoles,
  canViewResourceDashboard,
  canViewResourceContent,
  canViewResourceWorkflow,
  canViewResourceDiscovery,
  canViewResourceAnalytics,
} from '@/lib/resources/permissions';

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
    },
  });
}
