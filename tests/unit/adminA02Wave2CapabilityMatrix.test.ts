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
//                               SECTION 6 (anon and authenticated hold NO
//                               EXECUTE on admin_reorder_related_content)
//                               and SECTION 8 (unauthenticated direct RPC
//                               call to the transition RPC is denied).
//   §4  explicit denial       -> the reorder route returns 401/403/404/409/
//                               422/500, never a misleading empty success;
//                               see tests/unit/resourcesRelatedReorder.test.ts
//                               and the route's own response mapping.
//   §13 fail closed           -> tests/unit/resourcesRelatedReorder.test.ts
//                               ("unexpected errors are never leaked") and
//                               tests/unit/resourcesSchedulingValidation.test.ts.
import { describe, it, expect } from 'vitest';
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
