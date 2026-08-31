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
