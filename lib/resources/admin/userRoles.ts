// Resources Admin — User & Role management + Author/Reviewer/Compliance
// Reviewer eligibility (post-closure hotfix, see
// FHIP_RESOURCES_ADMIN_ROLE_CTA_MANAGEMENT_HOTFIX_REPORT.md section E/G/H).
//
// ROOT CAUSE this file exists to fix: resource_posts.author_id / reviewer_id
// / compliance_reviewer_id all reference resource_authors(id), a separate
// identity table from resource_user_roles (the actual RBAC table). Nothing
// in R1.1-R1.7 ever built (a) an Admin screen to assign resource_user_roles
// to real users, or (b) a link that provisions a resource_authors row for a
// user once they hold an eligible role. The three editor dropdowns (Author/
// Reviewer/Compliance Reviewer) all read the same undifferentiated
// resource_authors.is_active list (lib/resources/editor/queries.ts's old
// getResourceActiveAuthors()), which on live DEV contained only 11 leftover
// `user_id IS NULL` R1.3 test fixtures — zero real, usable, role-backed
// options for any of the three fields.
//
// This file is server-only (imports the service-role admin client) and must
// never be imported from a Client Component. Every exported mutating
// function takes an already-authorised admin Supabase client — the caller
// (an API route) is responsible for verifying canManageResources(current)
// BEFORE calling anything here (spec §9/§26: no privileged write without a
// real, auditable admin check performed first, mirroring
// lib/services/adminAuth.ts's requireAdmin() pattern).

import type { SupabaseClient } from '@supabase/supabase-js';
import { slugify } from '@/lib/resources/editor/slug';
import type { ResourceRole } from '@/lib/resources/types';

export const RESOURCE_ROLES: ResourceRole[] = ['resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst'];

// spec §28/§29 — readable labels + short descriptions for the Users & Roles
// admin screen. Canonical role IDs (RESOURCE_ROLES above) remain what is
// actually stored; these are display-only.
export const RESOURCE_ROLE_LABELS: Record<ResourceRole, string> = {
  resource_admin: 'Resource Administrator',
  author: 'Author',
  editor: 'Editor',
  compliance_reviewer: 'Compliance Reviewer',
  publisher: 'Publisher',
  analyst: 'Analyst',
};

export const RESOURCE_ROLE_DESCRIPTIONS: Record<ResourceRole, string> = {
  resource_admin: 'Manages Resources content configuration and user roles.',
  author: 'Creates/edits Resource content according to permissions.',
  editor: 'Performs editorial review.',
  compliance_reviewer: 'Reviews AMBER compliance-sensitive content.',
  publisher: 'Controls final publishing/scheduling.',
  analyst: 'Read/analytics functions as defined.',
};

// Eligibility sets for the three editor identity pickers. These are not a
// guess — they mirror, field for field, the permission predicates already
// enforced by public.transition_resource_post_status() (supabase/migrations
// /0049 §13, re-emitted from 0033/0035): v_can_editorial = has 'editor' OR
// can_manage_resources() (resource_admin/super admin); v_can_compliance =
// has 'compliance_reviewer' OR can_manage_resources(). A user who appears in
// the Reviewer or Compliance Reviewer dropdown by this rule can therefore
// never be rejected later by the workflow RPC for lacking the role (spec
// §12). Author eligibility (resource_admin also counts) is the one
// documented judgment call — see the completion report section J — grounded
// in isResourceStaff()/canCreateResource() already treating resource_admin
// as having full content-authoring capability.
export const AUTHOR_ELIGIBLE_ROLES: ResourceRole[] = ['author', 'resource_admin'];
export const REVIEWER_ELIGIBLE_ROLES: ResourceRole[] = ['editor', 'resource_admin'];
export const COMPLIANCE_REVIEWER_ELIGIBLE_ROLES: ResourceRole[] = ['compliance_reviewer', 'resource_admin'];

export interface AdminUserRoleRow {
  role: ResourceRole;
  is_active: boolean;
  assigned_at: string;
  assigned_by: string | null;
  updated_at: string;
}

export interface AdminUserListItem {
  id: string;
  email: string;
  fullName: string | null;
  isSuperAdmin: boolean;
  roles: AdminUserRoleRow[];
  lastUpdated: string | null;
  createdAt: string;
}

interface RawAuthUser {
  id: string;
  email?: string | null;
  created_at: string;
}

// GoTrue Admin API pagination — loop until a page returns fewer than
// requested (295 total users at time of writing; this scales without a code
// change as the user base grows, rather than hardcoding a single-page
// assumption).
async function listAllAuthUsers(admin: SupabaseClient): Promise<RawAuthUser[]> {
  const perPage = 1000;
  let page = 1;
  const out: RawAuthUser[] = [];
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = (data?.users ?? []) as RawAuthUser[];
    out.push(...users);
    if (users.length < perPage) break;
    page += 1;
    if (page > 20) break; // hard safety cap (20k users) — this project is nowhere near that scale
  }
  return out;
}

// spec §6: "view eligible application users and their Resources roles...
// Search user." No search term -> the roster view (only users who currently
// hold >=1 active Resources role, or are FHIP Super Admin) so the screen
// isn't flooded by the ~295 unrelated app users (regression-fixture
// personas, ordinary FHIP customers) who have never touched Resources. A
// search term searches every app user by email/name so a Resource Admin can
// find someone new to assign a role to.
export async function listResourceUsers(admin: SupabaseClient, opts: { search?: string } = {}): Promise<AdminUserListItem[]> {
  const search = opts.search?.trim().toLowerCase();

  const [authUsers, { data: profileRows }, { data: roleRows }, { data: adminRows }] = await Promise.all([
    listAllAuthUsers(admin),
    admin.from('user_profiles').select('user_id, full_name'),
    admin.from('resource_user_roles').select('user_id, role, is_active, assigned_at, assigned_by, updated_at'),
    admin.from('admin_users').select('user_id'),
  ]);

  const fullNameByUser = new Map<string, string | null>((profileRows ?? []).map((p: { user_id: string; full_name: string | null }) => [p.user_id, p.full_name]));
  const superAdminIds = new Set<string>((adminRows ?? []).map((a: { user_id: string }) => a.user_id));
  const rolesByUser = new Map<string, AdminUserRoleRow[]>();
  for (const r of (roleRows ?? []) as { user_id: string; role: ResourceRole; is_active: boolean; assigned_at: string; assigned_by: string | null; updated_at: string }[]) {
    const list = rolesByUser.get(r.user_id) ?? [];
    list.push({ role: r.role, is_active: r.is_active, assigned_at: r.assigned_at, assigned_by: r.assigned_by, updated_at: r.updated_at });
    rolesByUser.set(r.user_id, list);
  }

  let candidates = authUsers;
  if (search && search.length >= 2) {
    candidates = authUsers.filter((u) => {
      const email = (u.email ?? '').toLowerCase();
      const name = (fullNameByUser.get(u.id) ?? '').toLowerCase();
      return email.includes(search) || name.includes(search);
    });
  } else {
    candidates = authUsers.filter((u) => superAdminIds.has(u.id) || (rolesByUser.get(u.id) ?? []).length > 0);
  }

  return candidates
    .map((u) => {
      const roles = rolesByUser.get(u.id) ?? [];
      const lastUpdated = roles.reduce<string | null>((acc, r) => (!acc || r.updated_at > acc ? r.updated_at : acc), null);
      return {
        id: u.id,
        email: u.email ?? '(no email on file)',
        fullName: fullNameByUser.get(u.id) ?? null,
        isSuperAdmin: superAdminIds.has(u.id),
        roles,
        lastUpdated,
        createdAt: u.created_at,
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email))
    .slice(0, 200); // defensive cap on a single response — search narrows further if needed
}

// The live cross-reference behind the Author/Reviewer/Compliance Reviewer
// dropdowns (spec §11-13): which real user_ids currently hold an eligible
// role. Deliberately includes every FHIP Super Admin unconditionally,
// mirroring private.can_manage_resources() exactly, not just resource_admin
// role-holders.
export async function getEligibleUserIdSet(admin: SupabaseClient, roles: ResourceRole[]): Promise<Set<string>> {
  const [{ data: roleRows, error: roleErr }, { data: superAdmins, error: adminErr }] = await Promise.all([
    admin.from('resource_user_roles').select('user_id').eq('is_active', true).in('role', roles),
    admin.from('admin_users').select('user_id'),
  ]);
  if (roleErr) throw roleErr;
  if (adminErr) throw adminErr;
  const set = new Set<string>();
  for (const r of (roleRows ?? []) as { user_id: string }[]) set.add(r.user_id);
  for (const r of (superAdmins ?? []) as { user_id: string }[]) set.add(r.user_id);
  return set;
}

// Auto-provisions the resource_authors row a newly role-eligible user needs
// in order to ever appear in the Author/Reviewer/Compliance Reviewer
// dropdowns at all (resource_posts' three identity FKs point at
// resource_authors(id), never at auth.users(id) directly — see the header
// comment). Idempotent: reactivates an existing inactive row rather than
// creating a duplicate; a no-op if an active row already exists.
export async function ensureResourceAuthorForUser(admin: SupabaseClient, userId: string, info: { fullName: string | null; email: string }): Promise<void> {
  const { data: existing, error: findErr } = await admin.from('resource_authors').select('id, is_active').eq('user_id', userId).maybeSingle();
  if (findErr) throw findErr;
  if (existing) {
    if (!existing.is_active) {
      const { error } = await admin.from('resource_authors').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', existing.id);
      if (error) throw error;
    }
    return;
  }

  const displayName = info.fullName?.trim() || info.email.split('@')[0] || 'Staff Member';
  const base = slugify(displayName) || 'staff-member';
  let candidate = base;
  let suffix = 1;
  for (;;) {
    const { data: clash, error } = await admin.from('resource_authors').select('id').eq('slug', candidate).maybeSingle();
    if (error) throw error;
    if (!clash) break;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  const { error: insertErr } = await admin.from('resource_authors').insert({ user_id: userId, display_name: displayName, slug: candidate, is_active: true });
  if (insertErr) throw insertErr;
}

export interface RoleMutationResult {
  ok: boolean;
  error?: string;
}

// spec §9/§27: assign a role to a real user. The caller (API route) has
// already verified the actor is canManageResources() — this function does
// not re-check that (it has no request context), it only performs the write
// and the audit trail, using the service-role client because
// resource_user_roles grants zero authenticated write access by design
// (0033's own comment: "role assignment/removal happens via the
// service-role client only").
export async function assignResourceRole(admin: SupabaseClient, params: { targetUserId: string; role: ResourceRole; actorUserId: string }): Promise<RoleMutationResult> {
  const { data: existing, error: findErr } = await admin.from('resource_user_roles').select('id, is_active').eq('user_id', params.targetUserId).eq('role', params.role).maybeSingle();
  if (findErr) return { ok: false, error: findErr.message };

  const before = existing ? { is_active: existing.is_active } : null;
  if (existing) {
    const { error } = await admin
      .from('resource_user_roles')
      .update({ is_active: true, assigned_by: params.actorUserId, assigned_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await admin.from('resource_user_roles').insert({ user_id: params.targetUserId, role: params.role, assigned_by: params.actorUserId, is_active: true });
    if (error) return { ok: false, error: error.message };
  }

  // spec §11-13: auto-provision the resource_authors identity row so the
  // new role holder actually appears in the dropdowns immediately (spec
  // §33: "should reflect the change without requiring an application
  // redeploy").
  if (AUTHOR_ELIGIBLE_ROLES.includes(params.role) || REVIEWER_ELIGIBLE_ROLES.includes(params.role) || COMPLIANCE_REVIEWER_ELIGIBLE_ROLES.includes(params.role)) {
    const { data: userRes } = await admin.auth.admin.getUserById(params.targetUserId);
    const email = userRes?.user?.email;
    if (email) {
      const { data: profile } = await admin.from('user_profiles').select('full_name').eq('user_id', params.targetUserId).maybeSingle();
      await ensureResourceAuthorForUser(admin, params.targetUserId, { fullName: profile?.full_name ?? null, email });
    }
  }

  await admin.from('resource_audit_log').insert({
    entity_type: 'resource_user_role',
    entity_id: null,
    action: 'ROLE_ASSIGNED',
    actor_user_id: params.actorUserId,
    before_state: before,
    after_state: { role: params.role, is_active: true },
    metadata: { target_user_id: params.targetUserId },
  });

  return { ok: true };
}

// spec §10/§27: remove (deactivate — never hard-delete, spec §34: "do not
// silently clear historical assignments") a role from a real user. Hard
// blocks removing the final active resource_admin role-holder, satisfying
// spec §10's "at minimum: do not allow removal of the final active
// Resources Admin" — applies identically whether the actor is removing their
// own role or someone else's, which is the simplest correct implementation
// of "never allow self-removal into lockout" (a self-removal that would not
// cause a lockout is still allowed, matching "at minimum").
export async function removeResourceRole(admin: SupabaseClient, params: { targetUserId: string; role: ResourceRole; actorUserId: string }): Promise<RoleMutationResult> {
  if (params.role === 'resource_admin') {
    const { data: activeAdmins, error } = await admin.from('resource_user_roles').select('user_id').eq('role', 'resource_admin').eq('is_active', true);
    if (error) return { ok: false, error: error.message };
    const remaining = (activeAdmins ?? []).filter((r: { user_id: string }) => r.user_id !== params.targetUserId);
    if (remaining.length === 0) {
      return { ok: false, error: 'Cannot remove the final active Resource Administrator — this would lock every Resource Admin out of Resources administration. Assign resource_admin to another user first.' };
    }
  }

  const { data: existing, error: findErr } = await admin.from('resource_user_roles').select('id, is_active').eq('user_id', params.targetUserId).eq('role', params.role).maybeSingle();
  if (findErr) return { ok: false, error: findErr.message };
  if (!existing || !existing.is_active) return { ok: true }; // idempotent no-op — nothing active to remove

  const { error } = await admin.from('resource_user_roles').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', existing.id);
  if (error) return { ok: false, error: error.message };

  await admin.from('resource_audit_log').insert({
    entity_type: 'resource_user_role',
    entity_id: null,
    action: 'ROLE_REMOVED',
    actor_user_id: params.actorUserId,
    before_state: { is_active: true },
    after_state: { is_active: false },
    metadata: { target_user_id: params.targetUserId, role: params.role },
  });

  return { ok: true };
}
