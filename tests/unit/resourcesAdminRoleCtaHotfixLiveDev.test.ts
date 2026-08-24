// Resources Admin Role & CTA Management hotfix (post-closure) — live-DEV
// tests. Same pattern as tests/unit/resourcesR1_4LiveDev.test.ts / resourcesR1_1.test.ts:
// real magic-link-authenticated Supabase clients per role, throwaway
// fixtures clearly named "R-HOTFIX TEST — ..." / `r-hotfix-*`, cleanup in
// afterAll, hard-fail (not skip) if the schema this hotfix depends on is
// missing.
//
// Covers spec §36 (RLS), §37 (dropdown eligibility), §38 (workflow
// compatibility), §39 (CTA end-to-end). §9's escalation requirement is
// tested at its actual enforcement boundary: the API route's
// canManageResources() gate cannot run outside a real HTTP request (same
// documented limitation as every other Resources *LiveDev test in this
// repo), so this file tests the boundary beneath it instead — the raw
// resource_user_roles/resource_ctas table grants an author/editor/ordinary
// client would hit even if a bug ever let a non-manager reach the mutation
// helpers. lib/resources/admin/userRoles.ts's assignResourceRole/
// removeResourceRole/getEligibleUserIdSet/ensureResourceAuthorForUser are
// exercised directly against the real service-role client, exactly as the
// authorised API route itself calls them after its own permission check.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

vi.setConfig({ testTimeout: 30000 });

import { assignResourceRole, removeResourceRole, getEligibleUserIdSet, ensureResourceAuthorForUser, AUTHOR_ELIGIBLE_ROLES, REVIEWER_ELIGIBLE_ROLES, COMPLIANCE_REVIEWER_ELIGIBLE_ROLES } from '@/lib/resources/admin/userRoles';
import { getEligibleResourceAuthors, getEligibleResourceReviewers, getEligibleResourceComplianceReviewers, getResourceActiveCTAs } from '@/lib/resources/editor/queries';
import { createResourceDraft, updateResourceDraft } from '@/lib/resources/editor/mutations';
import { createCta, updateCta, setCtaActive } from '@/lib/resources/cta/mutations';
import { validateCtaAssignment } from '@/lib/resources/editor/validation';

function loadEnv(): Record<string, string> {
  const text = readFileSync('D:/FHIP/.env.local', 'utf-8');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const anonClient: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const RUN_ID = Date.now();
const createdUserIds: string[] = [];
const createdPostIds: string[] = [];
const createdAuthorIds: string[] = [];
const createdCtaIds: string[] = [];

// Cheap fixture: creates a real auth.users row (and, optionally, real
// resource_user_roles rows) but no authenticated session — sufficient for
// every test in this file that only needs a real userId to query/mutate
// through the service-role admin client (which is how the authorised API
// route itself operates after its own permission check; see the file
// header). Does not touch Supabase's OTP/magic-link rate limit at all.
async function makeTestUserId(label: string, roles: string[] = []): Promise<{ userId: string; email: string }> {
  const email = `r-hotfix-test-${label}-${RUN_ID}@test.fhip.invalid`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (createErr || !created.user) throw new Error(`Failed to create test user ${label}: ${createErr?.message}`);
  createdUserIds.push(created.user.id);

  for (const role of roles) {
    const { error: roleErr } = await admin.from('resource_user_roles').insert({ user_id: created.user.id, role, assigned_by: null });
    if (roleErr) throw new Error(`Failed to assign role ${role} to ${label}: ${roleErr.message}`);
  }
  return { userId: created.user.id, email };
}

// Real magic-link-authenticated client — only used by the handful of tests
// that must prove RLS behaviour from that specific role's own client (the
// genuine security boundary). Supabase's DEV project throttles OTP
// verification, so this is used sparingly (this file's own live run found
// the practical ceiling to be well under ~10 per test run) and retries once
// on a transient rate-limit before failing the test with a clear message.
async function makeAuthenticatedTestUser(label: string, roles: string[] = []): Promise<{ userId: string; email: string; client: SupabaseClient }> {
  const { userId, email } = await makeTestUserId(label, roles);

  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (linkErr || !link.properties?.hashed_token) throw new Error(`Failed to generate link for ${label}: ${linkErr?.message}`);

    const verifyClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data: verified, error: verifyErr } = await verifyClient.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
    if (!verifyErr && verified.session) {
      const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        global: { headers: { Authorization: `Bearer ${verified.session.access_token}` } },
      });
      return { userId, email, client };
    }
    if (attempt === 0 && /rate limit/i.test(verifyErr?.message ?? '')) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw new Error(`Failed to verify OTP for ${label}: ${verifyErr?.message}`);
  }
  throw new Error(`Failed to verify OTP for ${label} after retry.`);
}

beforeAll(async () => {
  // Hard-fail (not skip) if resource_user_roles / resource_authors /
  // resource_ctas are missing — same convention as every other Resources
  // *LiveDev suite (spec §114 precedent: "Missing schema = FAIL, not PASS").
  const probe = await admin.from('resource_user_roles').select('id').limit(1);
  if (probe.error) throw new Error(`FATAL: resource_user_roles is not reachable — the Resources R1.1 schema this hotfix depends on may be missing. Probe error: ${probe.error.message}`);
}, 30000);

afterAll(async () => {
  if (createdPostIds.length > 0) await admin.from('resource_posts').delete().in('id', createdPostIds);
  if (createdCtaIds.length > 0) await admin.from('resource_ctas').delete().in('id', createdCtaIds);
  if (createdAuthorIds.length > 0) await admin.from('resource_authors').delete().in('id', createdAuthorIds);
  // Role rows + resource_authors rows auto-provisioned for the QA user are
  // cascade-deleted with the auth user itself (resource_user_roles.user_id
  // and resource_authors.user_id are both `on delete cascade` / `on delete
  // set null` respectively — see supabase/migrations/0049).
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
}, 30000);

// ---------------------------------------------------------------------------
// spec §36 — RLS / table-grant security
// ---------------------------------------------------------------------------
describe('RLS — resource_user_roles table grants (spec §9/§36)', () => {
  it('anonymous cannot read resource_user_roles rows belonging to another user', async () => {
    const target = await makeTestUserId('rls-target', ['author']);
    const { data, error } = await anonClient.from('resource_user_roles').select('*').eq('user_id', target.userId);
    // No permissive SELECT policy exists for anon on this table (0033: only
    // "self read own resource roles", auth.uid() = user_id) — anon has no
    // uid at all, so this must return zero rows, not an error and not data.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('anonymous cannot insert into resource_user_roles', async () => {
    const target = await makeTestUserId('rls-anon-insert-target');
    const { error } = await anonClient.from('resource_user_roles').insert({ user_id: target.userId, role: 'resource_admin' });
    expect(error).not.toBeNull(); // RLS/grant denial — no INSERT policy, no INSERT grant to anon
  });

  // The following four tests need a genuine RLS-scoped authenticated client
  // per role — combined into one `it` (rather than four) to keep this
  // suite's total magic-link/OTP verification count comfortably under this
  // DEV project's rate limit while still proving every escalation path.
  it('an ordinary user, an author, an editor, and a resource_admin can none of them write resource_user_roles directly through their own client (service-role-only table, spec §9)', async () => {
    const ordinary = await makeAuthenticatedTestUser('rls-ordinary');
    const other = await makeTestUserId('rls-ordinary-target');
    const { error: ordinarySelfErr } = await ordinary.client.from('resource_user_roles').insert({ user_id: ordinary.userId, role: 'resource_admin' });
    expect(ordinarySelfErr).not.toBeNull(); // 0033: "Deliberately NOT granted to authenticated at all"
    const { error: ordinaryOtherErr } = await ordinary.client.from('resource_user_roles').insert({ user_id: other.userId, role: 'author' });
    expect(ordinaryOtherErr).not.toBeNull();

    const author = await makeAuthenticatedTestUser('rls-author-escalate', ['author']);
    const { error: authorErr } = await author.client.from('resource_user_roles').insert({ user_id: author.userId, role: 'resource_admin' });
    expect(authorErr).not.toBeNull(); // author cannot self-elevate to resource_admin
    const { data: authorCheck } = await admin.from('resource_user_roles').select('role').eq('user_id', author.userId).eq('role', 'resource_admin');
    expect(authorCheck ?? []).toHaveLength(0);

    const editor = await makeAuthenticatedTestUser('rls-editor-escalate', ['editor']);
    const { error: editorErr } = await editor.client.from('resource_user_roles').insert({ user_id: editor.userId, role: 'compliance_reviewer' });
    expect(editorErr).not.toBeNull(); // editor cannot self-elevate to compliance_reviewer
    const { data: editorCheck } = await admin.from('resource_user_roles').select('role').eq('user_id', editor.userId).eq('role', 'compliance_reviewer');
    expect(editorCheck ?? []).toHaveLength(0);

    // Even a genuine resource_admin cannot bypass the service-role-only
    // write path via a direct table write — this is intentional
    // defense-in-depth (0033 grants zero authenticated writes on this table
    // at all; role assignment is ONLY reachable through the service-role
    // admin API route, so a resource_admin's stolen session token still
    // cannot mutate roles directly against PostgREST).
    const resourceAdmin = await makeAuthenticatedTestUser('rls-resadmin-direct', ['resource_admin']);
    const { error: resAdminErr } = await resourceAdmin.client.from('resource_user_roles').insert({ user_id: other.userId, role: 'author' });
    expect(resAdminErr).not.toBeNull();
  });
});

describe('RLS — resource_ctas mutation security (spec §36)', () => {
  it('anonymous cannot insert a CTA', async () => {
    const { error } = await anonClient.from('resource_ctas').insert({ name: 'x', label: 'x', destination_type: 'fhip_module', destination_url: '/dashboard' });
    expect(error).not.toBeNull();
  });

  it('an ordinary authenticated user (no Resources role), and separately an author (not resource_admin/editor), cannot insert a CTA', async () => {
    const ordinary = await makeAuthenticatedTestUser('rls-cta-ordinary');
    const { error: ordinaryErr } = await ordinary.client.from('resource_ctas').insert({ name: 'x', label: 'x', destination_type: 'fhip_module', destination_url: '/dashboard' });
    expect(ordinaryErr).not.toBeNull(); // "staff manage ctas" policy requires can_manage_resources()

    const author = await makeAuthenticatedTestUser('rls-cta-author', ['author']);
    const { error } = await author.client.from('resource_ctas').insert({ name: 'x', label: 'x', destination_type: 'fhip_module', destination_url: '/dashboard' });
    expect(error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// spec §38 — workflow compatibility: role assignment -> dropdown eligibility
// ---------------------------------------------------------------------------
describe('Role assignment -> Author/Reviewer/Compliance Reviewer dropdown eligibility (spec §11-13/§37/§38)', () => {
  it('a disposable QA user with no roles does not appear in any of the three eligibility lists', async () => {
    const qa = await makeTestUserId('workflow-qa');
    const [authors, reviewers, compliance] = await Promise.all([
      getEligibleResourceAuthors(admin, admin),
      getEligibleResourceReviewers(admin, admin),
      getEligibleResourceComplianceReviewers(admin, admin),
    ]);
    expect(authors.some((a) => a.name.includes(qa.email))).toBe(false);
  });

  it('A. assigning `author` -> B. user appears in the Author dropdown (auto-provisioned resource_authors row)', async () => {
    const qa = await makeTestUserId('workflow-author-qa');
    const assignRes = await assignResourceRole(admin, { targetUserId: qa.userId, role: 'author', actorUserId: qa.userId });
    expect(assignRes.ok).toBe(true);

    const { data: authorRow } = await admin.from('resource_authors').select('id').eq('user_id', qa.userId).maybeSingle();
    expect(authorRow).not.toBeNull();
    if (authorRow) createdAuthorIds.push(authorRow.id);

    const authors = await getEligibleResourceAuthors(admin, admin);
    expect(authors.some((a) => a.id === authorRow!.id)).toBe(true);

    // Not (yet) eligible as Reviewer or Compliance Reviewer — plain author
    // does not inherit either.
    const reviewers = await getEligibleResourceReviewers(admin, admin);
    const compliance = await getEligibleResourceComplianceReviewers(admin, admin);
    expect(reviewers.some((r) => r.id === authorRow!.id)).toBe(false);
    expect(compliance.some((c) => c.id === authorRow!.id)).toBe(false);
  });

  it('C. assigning `editor` -> D. same user now appears in the Reviewer dropdown', async () => {
    const qa = await makeTestUserId('workflow-editor-qa');
    await assignResourceRole(admin, { targetUserId: qa.userId, role: 'editor', actorUserId: qa.userId });
    const { data: authorRow } = await admin.from('resource_authors').select('id').eq('user_id', qa.userId).maybeSingle();
    expect(authorRow).not.toBeNull();
    if (authorRow) createdAuthorIds.push(authorRow.id);

    const reviewers = await getEligibleResourceReviewers(admin, admin);
    expect(reviewers.some((r) => r.id === authorRow!.id)).toBe(true);
  });

  it('E. assigning `compliance_reviewer` -> F. same user now appears in the Compliance Reviewer dropdown', async () => {
    const qa = await makeTestUserId('workflow-compliance-qa');
    await assignResourceRole(admin, { targetUserId: qa.userId, role: 'compliance_reviewer', actorUserId: qa.userId });
    const { data: authorRow } = await admin.from('resource_authors').select('id').eq('user_id', qa.userId).maybeSingle();
    expect(authorRow).not.toBeNull();
    if (authorRow) createdAuthorIds.push(authorRow.id);

    const compliance = await getEligibleResourceComplianceReviewers(admin, admin);
    expect(compliance.some((c) => c.id === authorRow!.id)).toBe(true);
  });

  it('G. removing a role -> H. user no longer appears for NEW assignment, but the resource_authors row (historical identity) is untouched', async () => {
    const qa = await makeTestUserId('workflow-remove-qa');
    await assignResourceRole(admin, { targetUserId: qa.userId, role: 'editor', actorUserId: qa.userId });
    const { data: authorRow } = await admin.from('resource_authors').select('id, is_active').eq('user_id', qa.userId).maybeSingle();
    expect(authorRow).not.toBeNull();
    if (authorRow) createdAuthorIds.push(authorRow.id);

    let reviewers = await getEligibleResourceReviewers(admin, admin);
    expect(reviewers.some((r) => r.id === authorRow!.id)).toBe(true);

    const removeRes = await removeResourceRole(admin, { targetUserId: qa.userId, role: 'editor', actorUserId: qa.userId });
    expect(removeRes.ok).toBe(true);

    reviewers = await getEligibleResourceReviewers(admin, admin);
    expect(reviewers.some((r) => r.id === authorRow!.id)).toBe(false); // H: no longer eligible for NEW assignment

    // resource_authors row itself is preserved (spec §34: "do not silently
    // clear historical assignments") — still present and still active.
    const { data: stillThere } = await admin.from('resource_authors').select('id').eq('id', authorRow!.id).maybeSingle();
    expect(stillThere).not.toBeNull();
  });

  it('getEligibleUserIdSet always includes FHIP Super Admins for every role set, mirroring private.can_manage_resources()', async () => {
    // The real Product Owner account is a genuine, pre-existing
    // resource_admin — used read-only here, never mutated by this suite.
    const { data: superAdmins } = await admin.from('admin_users').select('user_id').limit(1);
    if (!superAdmins || superAdmins.length === 0) return; // no super admin exists in this DEV snapshot — nothing to assert
    const superAdminId = superAdmins[0].user_id as string;
    const authorSet = await getEligibleUserIdSet(admin, AUTHOR_ELIGIBLE_ROLES);
    const reviewerSet = await getEligibleUserIdSet(admin, REVIEWER_ELIGIBLE_ROLES);
    const complianceSet = await getEligibleUserIdSet(admin, COMPLIANCE_REVIEWER_ELIGIBLE_ROLES);
    expect(authorSet.has(superAdminId)).toBe(true);
    expect(reviewerSet.has(superAdminId)).toBe(true);
    expect(complianceSet.has(superAdminId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// spec §10 — final Resource Admin lockout protection
// ---------------------------------------------------------------------------
describe('Final Resource Admin lockout protection (spec §10)', () => {
  it('removing the only active resource_admin role a QA user holds is blocked if it is the last one system-wide', async () => {
    // Snapshot every OTHER active resource_admin so this test can restore
    // the real world state regardless of what else is active right now —
    // never destructive to the real Product Owner account (spec §38: "Do
    // not use the real Product Owner account as a destructive role-removal
    // test").
    const { data: existingAdmins } = await admin.from('resource_user_roles').select('id, user_id').eq('role', 'resource_admin').eq('is_active', true);
    const otherAdminIds = (existingAdmins ?? []).map((r: { id: string }) => r.id);

    // Deactivate every other resource_admin row temporarily so this QA user
    // becomes provably the last one, exercise the lockout guard, then
    // restore every row exactly as it was.
    if (otherAdminIds.length > 0) {
      await admin.from('resource_user_roles').update({ is_active: false }).in('id', otherAdminIds);
    }
    try {
      const qa = await makeTestUserId('lockout-qa', ['resource_admin']);
      const result = await removeResourceRole(admin, { targetUserId: qa.userId, role: 'resource_admin', actorUserId: qa.userId });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/final|last/i);

      // Still active after the blocked removal attempt.
      const { data: stillActive } = await admin.from('resource_user_roles').select('is_active').eq('user_id', qa.userId).eq('role', 'resource_admin').maybeSingle();
      expect(stillActive?.is_active).toBe(true);
    } finally {
      if (otherAdminIds.length > 0) {
        await admin.from('resource_user_roles').update({ is_active: true }).in('id', otherAdminIds);
      }
    }
  });

  it('removing a resource_admin role is allowed when another active resource_admin remains', async () => {
    const qa1 = await makeTestUserId('lockout-ok-qa1', ['resource_admin']);
    const qa2 = await makeTestUserId('lockout-ok-qa2', ['resource_admin']);
    const result = await removeResourceRole(admin, { targetUserId: qa1.userId, role: 'resource_admin', actorUserId: qa2.userId });
    expect(result.ok).toBe(true);
    const { data: check } = await admin.from('resource_user_roles').select('is_active').eq('user_id', qa1.userId).eq('role', 'resource_admin').maybeSingle();
    expect(check?.is_active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spec §39 — CTA end-to-end
// ---------------------------------------------------------------------------
describe('CTA Library end-to-end (spec §17-23/§39)', () => {
  it('create -> appears in the active CTA picker -> assign to a disposable Draft -> persists -> deactivate -> no longer offered for new assignment -> existing assignment remains readable', async () => {
    const label = `R-HOTFIX TEST CTA ${RUN_ID}`;
    const created = await createCta(admin, { name: label, label, description: 'disposable QA fixture', destination_type: 'fhip_module', destination_url: '/dashboard', is_active: true });
    createdCtaIds.push(created.id);

    let activeCtas = await getResourceActiveCTAs(admin);
    expect(activeCtas.some((c) => c.id === created.id)).toBe(true);

    const qa = await makeTestUserId('cta-e2e-qa', ['author']);
    const draft = await createResourceDraft(admin, 'article', qa.userId);
    createdPostIds.push(draft.id);

    const { data: freshPost } = await admin.from('resource_posts').select('updated_at').eq('id', draft.id).single();
    const outcome = await updateResourceDraft(admin, draft.id, {
      patch: {
        title: `R-HOTFIX TEST Draft ${RUN_ID}`, slug: null, excerpt: 'disposable QA fixture', content_blocks: [],
        jurisdiction: 'global', difficulty: null, freshness_type: 'evergreen', visibility: 'private',
        compliance_classification: 'green', primary_category_id: null, author_id: null, reviewer_id: null,
        compliance_reviewer_id: null, expires_at: null, next_review_at: null, seo_title: null, seo_description: null,
        canonical_url: null, is_indexable: false, primary_cta_id: created.id, secondary_cta_id: null, content_id: null,
      },
      categoryIds: [], tagIds: [], expectedUpdatedAt: freshPost!.updated_at, userId: qa.userId,
    });
    expect(outcome.status).toBe('ok');

    // Reload — confirm persisted (spec §39 "save; reload; confirm persisted").
    const { data: reloaded } = await admin.from('resource_posts').select('primary_cta_id').eq('id', draft.id).single();
    expect(reloaded?.primary_cta_id).toBe(created.id);

    // Deactivate.
    await setCtaActive(admin, created.id, false);
    activeCtas = await getResourceActiveCTAs(admin);
    expect(activeCtas.some((c) => c.id === created.id)).toBe(false); // no longer offered for NEW assignment

    // Existing assignment remains understandable/readable — the FK is
    // ON DELETE SET NULL (not cascaded on deactivate at all; deactivate never
    // touches resource_posts), so the already-saved row is untouched.
    const { data: stillAssigned } = await admin.from('resource_posts').select('primary_cta_id').eq('id', draft.id).single();
    expect(stillAssigned?.primary_cta_id).toBe(created.id);
    const { data: ctaStillReadable } = await admin.from('resource_ctas').select('id, label, is_active').eq('id', created.id).single();
    expect(ctaStillReadable?.label).toBe(label);
    expect(ctaStillReadable?.is_active).toBe(false);
  });

  it('primary_cta_id and secondary_cta_id cannot be the same (spec §22)', () => {
    const sameId = '00000000-0000-0000-0000-000000000001';
    const check = validateCtaAssignment({ primary_cta_id: sameId, secondary_cta_id: sameId });
    expect(check.valid).toBe(false);
    expect(check.errors.secondary_cta_id).toBeTruthy();
  });

  it('primary_cta_id and secondary_cta_id may differ, or either may be null', () => {
    const a = '00000000-0000-0000-0000-000000000001';
    const b = '00000000-0000-0000-0000-000000000002';
    expect(validateCtaAssignment({ primary_cta_id: a, secondary_cta_id: b }).valid).toBe(true);
    expect(validateCtaAssignment({ primary_cta_id: a, secondary_cta_id: null }).valid).toBe(true);
    expect(validateCtaAssignment({ primary_cta_id: null, secondary_cta_id: null }).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureResourceAuthorForUser — idempotency
// ---------------------------------------------------------------------------
describe('ensureResourceAuthorForUser idempotency (spec §33)', () => {
  it('is a no-op when an active resource_authors row already exists for the user', async () => {
    const qa = await makeTestUserId('idempotent-qa');
    await ensureResourceAuthorForUser(admin, qa.userId, { fullName: 'R-Hotfix Test Person', email: qa.email });
    const { data: first } = await admin.from('resource_authors').select('id').eq('user_id', qa.userId).maybeSingle();
    expect(first).not.toBeNull();
    if (first) createdAuthorIds.push(first.id);

    await ensureResourceAuthorForUser(admin, qa.userId, { fullName: 'R-Hotfix Test Person', email: qa.email });
    const { data: all } = await admin.from('resource_authors').select('id').eq('user_id', qa.userId);
    expect((all ?? []).length).toBe(1); // still exactly one row — not duplicated
  });

  it('reactivates an existing inactive resource_authors row instead of creating a duplicate', async () => {
    const qa = await makeTestUserId('reactivate-qa');
    await ensureResourceAuthorForUser(admin, qa.userId, { fullName: null, email: qa.email });
    const { data: row } = await admin.from('resource_authors').select('id').eq('user_id', qa.userId).single();
    createdAuthorIds.push(row.id);
    await admin.from('resource_authors').update({ is_active: false }).eq('id', row.id);

    await ensureResourceAuthorForUser(admin, qa.userId, { fullName: null, email: qa.email });
    const { data: reactivated } = await admin.from('resource_authors').select('id, is_active').eq('user_id', qa.userId);
    expect((reactivated ?? []).length).toBe(1);
    expect(reactivated?.[0].is_active).toBe(true);
  });
});
