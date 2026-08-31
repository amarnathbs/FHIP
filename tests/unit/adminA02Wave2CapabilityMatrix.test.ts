// Admin A0.2 Wave 2 — capability compliance tests for
// docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md (v1.0, effective
// 2026-08-30), which is mandatory for anything touching app/api/admin/**.
//
// Wave 2 touches two existing capabilities and introduces none:
//
//   1. canManageDiscovery — gates PATCH /api/admin/resources/related/reorder
//      (Scope A). Wave 2 changed how that route enforces and executes, never
//      who is authorised.
//   2. the Resources workflow transition authority (can_publish_resource et
//      al., enforced inside public.transition_resource_post_status) — gates
//      the transition to 'scheduled' across all four content types (Scope B).
//      Wave 2 added a scheduling rule AFTER those role checks and changed no
//      predicate.
//
// Standard sections proved here:
//   §2  capability-based access — each capability is separately named and
//       separately tested; no broad "has some admin role" boolean.
//   §3  multi-role composition — a user gets the UNION of their roles'
//       capabilities, and holding an extra role never narrows access.
//   §5  least privilege / separation of duties — in particular ANALYST IS
//       READ-ONLY and must not be able to reorder Related Content, nor
//       schedule or publish.
//
// Sections proved elsewhere, cross-referenced so the evidence trail is
// complete:
//   §4  database-bypass test  -> scripts/admin_a02_wave2_certification.mjs
//                               SECTIONS 6-6F. Under privileged-RPC Pattern A
//                               the reorder RPC is granted to `authenticated`
//                               and rechecks the capability ITSELF, so the
//                               bypass test is now behavioural as well as
//                               structural: Analyst/Author/Compliance
//                               Reviewer/Publisher/no-role each call the RPC
//                               directly, as themselves, with their own
//                               session, and are refused 42501 with zero
//                               database variance (6C); anon is refused at
//                               the grant layer (6D); a null auth.uid() fails
//                               closed in the function body (6E). SECTION 8
//                               covers the transition RPC equivalently.
//   §4  explicit denial       -> the reorder route returns 401/403/404/409/
//                               422/500, never a misleading empty success;
//                               see tests/unit/resourcesRelatedReorder.test.ts
//                               and the route's own response mapping.
//   §13 fail closed           -> tests/unit/resourcesRelatedReorder.test.ts
//                               ("unexpected errors are never leaked") and
//                               tests/unit/resourcesSchedulingValidation.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canManageDiscovery, canManageResources, hasResourceRole, type CurrentResourceRoles } from '@/lib/resources/permissions';
import type { ResourceRole } from '@/lib/resources/types';

const ALL_ROLES: ResourceRole[] = ['resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst'];

const as = (roles: ResourceRole[], isSuperAdmin = false): CurrentResourceRoles => ({ userId: 'u1', isSuperAdmin, roles });

describe('§2/§5 canManageDiscovery — the capability gating the Wave 2 reorder route', () => {
  it.each([['resource_admin'], ['editor']])('%s is PERMITTED', (role) => {
    expect(canManageDiscovery(as([role as ResourceRole]))).toBe(true);
  });

  it('Super Admin is PERMITTED', () => {
    expect(canManageDiscovery(as([], true))).toBe(true);
  });

  it.each([['author'], ['compliance_reviewer'], ['publisher'], ['analyst']])('%s is DENIED', (role) => {
    expect(canManageDiscovery(as([role as ResourceRole]))).toBe(false);
  });

  it('ANALYST IS DENIED — §5 "Analyst is read-only". Reordering Related Content is a write.', () => {
    expect(canManageDiscovery(as(['analyst']))).toBe(false);
  });

  it('Analyst is denied even when it is the only role and the caller is otherwise authenticated', () => {
    // §4: authentication alone is never authorisation. The route checks the
    // capability separately from auth.getUser().
    expect(canManageDiscovery({ userId: 'a-real-signed-in-user', isSuperAdmin: false, roles: ['analyst'] })).toBe(false);
  });

  it('an authenticated caller with NO Resources role at all is DENIED', () => {
    expect(canManageDiscovery(as([]))).toBe(false);
  });

  it('§2: is not a broad "has any Resources role" check — 4 of the 6 roles are refused', () => {
    const permitted = ALL_ROLES.filter((r) => canManageDiscovery(as([r])));
    expect(permitted.sort()).toEqual(['editor', 'resource_admin']);
  });

  it('§2: remains a SEPARATE capability from canManageResources, not an alias for it', () => {
    // editor may manage discovery but is NOT a resources manager — proof the
    // two capabilities are genuinely distinct and a future change to one
    // cannot silently change the other.
    expect(canManageDiscovery(as(['editor']))).toBe(true);
    expect(canManageResources(as(['editor']))).toBe(false);
  });
});

describe('§3 multi-role composition for the reorder capability', () => {
  it('holding Analyst IN ADDITION to Editor does not narrow the Editor capability', () => {
    expect(canManageDiscovery(as(['editor', 'analyst']))).toBe(true);
  });

  it('holding Analyst in addition to a non-permitted role does not GRANT the capability either', () => {
    expect(canManageDiscovery(as(['author', 'analyst']))).toBe(false);
    expect(canManageDiscovery(as(['publisher', 'analyst']))).toBe(false);
  });

  it('a caller receives the UNION of their roles: any one permitted role suffices', () => {
    expect(canManageDiscovery(as(['author', 'compliance_reviewer', 'resource_admin']))).toBe(true);
  });

  it('Analyst alone never composes into the capability, whatever order the roles are in', () => {
    expect(canManageDiscovery(as(['analyst', 'analyst']))).toBe(false);
  });
});

describe('§5 Analyst is excluded from the scheduling/publishing authority Wave 2 gates', () => {
  // The database predicate is private.can_publish_resource(uuid) =
  // has_resource_role(publisher) OR can_manage_resources(). This mirrors it
  // at the TypeScript layer so the exclusion is pinned in both places; the
  // authoritative database-side proof (an author role being refused with
  // "Only a Publisher, Resource Administrator, or Super Admin may schedule
  // or publish", for all four content types) is
  // scripts/admin_a02_wave2_certification.mjs SECTION 8.
  const canPublishMirror = (c: CurrentResourceRoles) => hasResourceRole(c, 'publisher') || canManageResources(c);

  it('Analyst cannot schedule or publish — §5 forbids it explicitly', () => {
    expect(canPublishMirror(as(['analyst']))).toBe(false);
  });

  it('Author and Compliance Reviewer cannot schedule or publish either', () => {
    expect(canPublishMirror(as(['author']))).toBe(false);
    expect(canPublishMirror(as(['compliance_reviewer']))).toBe(false);
  });

  it('Publisher, Resource Admin and Super Admin can', () => {
    expect(canPublishMirror(as(['publisher']))).toBe(true);
    expect(canPublishMirror(as(['resource_admin']))).toBe(true);
    expect(canPublishMirror(as([], true))).toBe(true);
  });

  it('Analyst + Publisher composes to permitted (Analyst never displaces another role — §3)', () => {
    expect(canPublishMirror(as(['analyst', 'publisher']))).toBe(true);
  });
});

describe('§14 no hidden scope expansion — Wave 2 changed no capability definition', () => {
  it('DISCOVERY_MANAGE_ROLES is still exactly {resource_admin, editor} plus Super Admin', () => {
    // Pinned so that a future edit widening this capability cannot land
    // quietly inside an unrelated change.
    const permitted = ALL_ROLES.filter((r) => canManageDiscovery(as([r])));
    expect(permitted).toEqual(['resource_admin', 'editor']);
    expect(canManageDiscovery(as([], true))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Privileged-RPC PATTERN A (Product Owner governance ruling, 2026-08-31).
//
// The reorder RPC is now caller-context: it obtains the actor from auth.uid()
// and rechecks the capability in the database. That makes the DATABASE the
// authority and the TypeScript predicate defence in depth — so the two must
// not be allowed to drift apart. The behavioural proof (each role calling the
// RPC with its own session) is in the certification script against a real
// PostgreSQL; what is pinned here is the source-level contract: the migration
// really does define the database twin, and it really does resolve to the same
// role set as canManageDiscovery().
// ---------------------------------------------------------------------------
describe('PATTERN A — the reorder RPC authorises its own caller', () => {
  const MIGRATION = readFileSync(
    join(process.cwd(), 'supabase/migrations/0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql'),
    'utf8'
  );

  it('0116 defines private.can_manage_discovery — the database mirror of canManageDiscovery()', () => {
    expect(MIGRATION).toMatch(/create or replace function private\.can_manage_discovery\(p_user_id uuid\)/);
  });

  it('the database mirror resolves to the SAME role set as the TypeScript predicate', () => {
    // Extract the SQL body and check it names exactly the roles
    // DISCOVERY_MANAGE_ROLES names, plus the super-admin predicate.
    const body = MIGRATION.split('create or replace function private.can_manage_discovery(p_user_id uuid)')[1].split('$$;')[0];
    const namedRoles = [...body.matchAll(/has_resource_role\(p_user_id, '([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    const tsRoles = ALL_ROLES.filter((r) => canManageDiscovery(as([r]))).sort();
    expect(namedRoles).toEqual(tsRoles);
    expect(body).toMatch(/is_fhip_super_admin\(p_user_id\)/); // Super Admin, matching isSuperAdmin
    // and no other role leaks in
    for (const r of ALL_ROLES.filter((x) => !tsRoles.includes(x))) expect(body).not.toContain(`'${r}'`);
  });

  it('the reorder RPC takes the actor from auth.uid() and fails closed when it is null', () => {
    expect(MIGRATION).toMatch(/v_actor uuid := auth\.uid\(\)/);
    expect(MIGRATION).toMatch(/if v_actor is null then[\s\S]{0,200}?raise exception[\s\S]{0,200}?errcode = '42501'/);
  });

  it('the reorder RPC rechecks the capability itself, independently of the API route', () => {
    expect(MIGRATION).toMatch(/if not private\.can_manage_discovery\(v_actor\) then/);
  });

  it('the reorder RPC accepts no client-supplied identity parameter', () => {
    const fn = MIGRATION.split('create or replace function public.admin_reorder_related_content(')[1].split(')')[0];
    expect(fn).toContain('p_source_post_id uuid');
    expect(fn).toContain('p_ordered_ids uuid[]');
    expect(fn).not.toMatch(/p_actor|p_user_id|p_role/);
  });

  it('EXECUTE is granted to authenticated and revoked from public, anon and service_role', () => {
    const sig = 'public.admin_reorder_related_content(uuid, uuid[])';
    expect(MIGRATION).toContain(`grant execute on function ${sig} to authenticated;`);
    for (const role of ['public', 'anon', 'service_role']) {
      expect(MIGRATION).toContain(`revoke all on function ${sig} from ${role};`);
    }
    expect(MIGRATION).not.toContain(`grant execute on function ${sig} to service_role`);
    expect(MIGRATION).not.toContain(`grant execute on function ${sig} to authenticated, service_role`);
  });

  it('0107 and 0109 are NOT touched — they remain approved Pattern B exceptions', () => {
    // The ruling is explicit: do not reopen Waves 1/1B here.
    expect(MIGRATION).not.toMatch(/admin_import_recommendation_conditions|admin_upsert_recommendation_atomic/);
  });
});
