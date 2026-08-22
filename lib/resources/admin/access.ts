// Resources / Financial Knowledge & Insights — R1.2 Admin shell access gate.
//
// Entry rule (spec §10): a user may enter /admin/resources if they hold at
// least one Resources role (any of the 6 resource_user_roles values) or are
// FHIP Super Admin. This is a coarse "can you see the shell at all" gate —
// it is NOT the security boundary. RLS (supabase/migrations/0033) remains
// authoritative for which *rows* each role can actually read/write; this
// helper only decides whether to render the shell or redirect away, exactly
// like the existing requireAdmin()/admin_users pattern in
// lib/services/adminAuth.ts, extended to the 6 Resources roles (spec §90:
// "Navigation hiding is only UX", never a substitute for RLS).

import { redirect } from 'next/navigation';
import { getCurrentResourceRoles, type CurrentResourceRoles } from '@/lib/resources/permissions';

export async function requireResourceAdminAccess(): Promise<CurrentResourceRoles> {
  const current = await getCurrentResourceRoles();
  if (!current.userId) redirect('/login');
  if (!current.isSuperAdmin && current.roles.length === 0) redirect('/dashboard');
  return current;
}
