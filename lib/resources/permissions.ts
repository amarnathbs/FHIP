// Resources / Financial Knowledge & Insights — R1.1 server-side permission
// helpers. No UI. Server-only where privileged data is involved (spec §62).
//
// These mirror the SQL logic in the `private.*` helper functions defined in
// supabase/migrations/0033_resources_foundation.sql exactly (is_fhip_super_admin
// / has_resource_role / can_manage_resources / is_resource_staff /
// can_publish_resource) — that SQL is the authoritative enforcement layer
// (RLS policies call it directly), this TypeScript layer exists only so
// server actions/route handlers can make the same decision *before* issuing
// a query, for early 403s and clearer error messages. It is never trusted
// as the sole gate — every privileged write still goes through RLS and,
// for resource_posts status changes, through the
// public.transition_resource_post_status RPC (spec §63: never trust a
// client-supplied role).
//
// `private.*` functions are not callable from here (that schema is not
// exposed to PostgREST by design — see the migration's header comment), so
// this reads resource_user_roles / admin_users directly through the
// request-scoped Supabase client, relying on the same "self read own rows"
// RLS policies the tables already have.

import { createClient } from '@/lib/supabase/server';
import type { ResourceRole } from './types';

export interface CurrentResourceRoles {
  userId: string | null;
  isSuperAdmin: boolean;
  roles: ResourceRole[];
}

export async function getCurrentResourceRoles(): Promise<CurrentResourceRoles> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { userId: null, isSuperAdmin: false, roles: [] };

  const [{ data: adminRow }, { data: roleRows }] = await Promise.all([
    supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('resource_user_roles').select('role').eq('user_id', user.id).eq('is_active', true),
  ]);

  return {
    userId: user.id,
    isSuperAdmin: !!adminRow,
    roles: (roleRows ?? []).map((r) => r.role as ResourceRole),
  };
}

export function hasResourceRole(current: CurrentResourceRoles, role: ResourceRole): boolean {
  return current.isSuperAdmin || current.roles.includes(role);
}

export function canManageResources(current: CurrentResourceRoles): boolean {
  return current.isSuperAdmin || hasResourceRole(current, 'resource_admin');
}

// Content-workflow staff only — deliberately excludes 'analyst'. Mirrors
// private.is_resource_staff() in the DB exactly (see the R1.1 closure-pass
// comment there): Analyst must not gain draft/workflow visibility merely
// because a resource_user_roles row exists for them.
const CONTENT_WORKFLOW_ROLES: ResourceRole[] = ['resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher'];

export function isResourceStaff(current: CurrentResourceRoles): boolean {
  return current.isSuperAdmin || current.roles.some((r) => CONTENT_WORKFLOW_ROLES.includes(r));
}

// Mirrors private.is_resource_analyst() — kept separate from
// isResourceStaff() on purpose. No R1.1 table/route grants anything based
// on this yet; it exists so a future analytics surface has a ready-made
// predicate.
export function isResourceAnalyst(current: CurrentResourceRoles): boolean {
  return current.isSuperAdmin || hasResourceRole(current, 'analyst');
}

export function canPublishResource(current: CurrentResourceRoles): boolean {
  return canManageResources(current) || hasResourceRole(current, 'publisher');
}

// "Create draft" per the §44 matrix: any Resources staff role (Author and
// above) may create a draft.
export function canCreateResource(current: CurrentResourceRoles): boolean {
  return isResourceStaff(current);
}

// "Edit own draft" / "edit any editorial draft" per §44 — the row-level
// distinction (own vs any) is enforced by RLS + the `created_by` column,
// not here; this only answers "does this user have an editing role at all".
export function canEditResource(current: CurrentResourceRoles): boolean {
  return isResourceStaff(current);
}

// "Review" covers both editorial review (Editor) and compliance review
// (Compliance Reviewer) — callers that need to distinguish which should
// check hasResourceRole() directly for the specific role.
export function canReviewResource(current: CurrentResourceRoles): boolean {
  return canManageResources(current) || hasResourceRole(current, 'editor') || hasResourceRole(current, 'compliance_reviewer');
}

export function canComplianceApproveResource(current: CurrentResourceRoles): boolean {
  return canManageResources(current) || hasResourceRole(current, 'compliance_reviewer');
}

// R1.4 — Video/Glossary/Money Update creation and FAQ management (spec
// §70/§71): a deliberately stricter set than isResourceStaff(), mirroring
// the exact CREATE_ROLES restriction R1.3's content-creation route already
// established (app/api/admin/resources/content/route.ts) — Publisher and
// Compliance Reviewer are excluded from content *creation* and from FAQ
// management specifically (spec §71: "Do not make Publisher a general FAQ
// editor merely because Publisher can publish posts"), even though both
// hold review-stage capabilities elsewhere in the workflow.
const SPECIALIST_CREATE_ROLES: ResourceRole[] = ['resource_admin', 'author', 'editor'];

export function canCreateSpecialistContent(current: CurrentResourceRoles): boolean {
  return current.isSuperAdmin || current.roles.some((r) => SPECIALIST_CREATE_ROLES.includes(r));
}

export function canManageFaqs(current: CurrentResourceRoles): boolean {
  return canCreateSpecialistContent(current);
}

// R1.6 — Related Content / CTA Library / Context Mapping admin (spec §79/
// §80: "Likely management roles: Super Admin, Resource Admin, Editor...
// Compliance Reviewer/Publisher should not automatically become mapping
// administrators unless existing RBAC says so." No existing RBAC document
// grants Publisher/Compliance Reviewer either capability, so this is
// deliberately narrower than isResourceStaff() — Analyst is excluded (must
// remain read-only per spec §79/§80, and is already excluded from
// isResourceStaff() itself).
const DISCOVERY_MANAGE_ROLES: ResourceRole[] = ['resource_admin', 'editor'];

export function canManageDiscovery(current: CurrentResourceRoles): boolean {
  return current.isSuperAdmin || current.roles.some((r) => DISCOVERY_MANAGE_ROLES.includes(r));
}
