import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  getCurrentResourceRoles,
  canViewResourceDashboard,
  canViewResourceContent,
  canViewResourceWorkflow,
  canViewResourceDiscovery,
  canViewResourceAnalytics,
  canManageResources,
} from '@/lib/resources/permissions';
import { buildAdminAreas } from '@/lib/admin/adminAreas';
import { AdminShell } from '@/components/admin/AdminShell';
import type { AdminCapabilities } from '@/lib/admin/adminNav';

// Admin A2 — Canonical Admin Shell and Navigation.
//
// Nested inside app/(app)/layout.tsx (which already enforces authentication
// and Mandatory Country Confirmation for every app/(app)/** route, admin
// included — see that file's own header comment) and wraps every page under
// app/(app)/admin/**. This layout computes the 8-area canonical nav model
// SERVER-SIDE, once per request, from the same getCurrentResourceRoles()
// snapshot every existing Resources/Admin predicate already uses — no new
// capability, no new API route, no client-side capability fetch.
//
// This layout is NOT the security boundary for any individual page (Admin
// Architecture Standard §4: "navigation is not authorisation"). Every page
// under app/(app)/admin/** keeps its own independent server-side gate
// exactly as before (e.g. admin/benchmarks/page.tsx's own admin_users
// check, admin/resources/users/page.tsx's own canManageResources() check) —
// this layout changing nothing about any of those. The `if (!user)` redirect
// below is defense in depth (the same pattern app/(app)/layout.tsx and
// several individual admin pages already use), not a replacement for any
// page's own check.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const current = await getCurrentResourceRoles();
  const isAdmin = current.isSuperAdmin;
  const capabilities: AdminCapabilities = {
    resourcesDashboard: canViewResourceDashboard(current),
    resourceContentAdmin: canViewResourceContent(current),
    resourceWorkflowAdmin: canViewResourceWorkflow(current),
    resourceDiscoveryAdmin: canViewResourceDiscovery(current),
    resourceAnalytics: canViewResourceAnalytics(current),
  };
  const canManageResourceUsers = canManageResources(current);

  const areas = buildAdminAreas(isAdmin, capabilities, canManageResourceUsers);

  return <AdminShell areas={areas}>{children}</AdminShell>;
}
