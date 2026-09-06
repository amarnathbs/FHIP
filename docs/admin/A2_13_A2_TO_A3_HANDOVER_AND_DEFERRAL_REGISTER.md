# A2-to-A3 Handover and Deferral Register

## 1. What A2 delivered (see `A2_01_IMPLEMENTATION_REPORT.md` for full detail)

One canonical Admin shell (`components/admin/AdminShell.tsx` + `app/(app)/admin/layout.tsx`), a typed navigation registry (`lib/admin/navigationRegistry.ts`) layered over the existing capability-driven area builder (`lib/admin/adminAreas.ts`), a role-aware Admin Home (`app/(app)/admin/home/page.tsx` + `lib/admin/homeQueues.ts`), breadcrumbs, mobile navigation with focus management, and 108 passing tests (83 pre-existing/reconciled + 25 new registry-integrity tests).

## 2. Deferred to A3 (per `A1_20`'s own roadmap, confirmed still correct scope for A3, not A2)

| Item | Why deferred | A3 sub-package |
|---|---|---|
| Split `requireAdmin()`/broad `isAdmin` into named capabilities (`canManageBenchmarks`, `canManageRecommendations`) | Not in this dispatch's §4 Included list; the safer, zero-authorization-risk choice for A2 is to keep the existing broad Super-Admin gate unchanged | A3.3 |
| Scheduled publishing (ADM-10) | Explicitly excluded from A2 (§4); needs a new worker/queue table | A3.1 |
| Physical route reorganisation of Discovery under Content (today it is nav-only, not a file-path move) | A2 changes nav parents, not URLs, per `A1_08` §10 | A3.2 |
| FDH-13 governance screens, any FDH Admin group | Explicitly excluded (§22) | FDH-13 Wave B+ |
| Analyst dashboards, a second Analyst nav | Explicitly excluded (§23); Analytics stays hidden until a real destination exists | Analyst workstream |
| Module 11 AI Admin Console | Explicitly excluded (§4); routes remain reachable only by direct URL, ungrouped in nav | Module 11 |
| Support/break-glass access | Explicitly excluded (§4) | A4 |

## 3. Reconstructable live-DEV verification helper (for the deferred live-browser pass)

The following script existed in this branch's working tree before this pass, was never executed during this reconciliation, and was deleted before commit per its own header instruction ("NOT part of the repository deliverable"). Its logic is preserved here so a follow-up pass does not need to re-derive the exact Supabase Admin API calls:

```js
// setup: creates a Super Admin, an Author, and an Analyst against DEV
// (guarded to project ref vqycarelcoijzwlpkpcz only), each with a magic-link
// action_link for direct sign-in.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY); // DEV only
async function makeUser(label, { adminUser, role }) {
  const { data: created } = await admin.auth.admin.createUser({ email: `a2-verify-${label}-${Date.now()}@test.fhip.invalid`, email_confirm: true });
  if (adminUser) await admin.from('admin_users').insert({ user_id: created.user.id });
  if (role) await admin.from('resource_user_roles').insert({ user_id: created.user.id, role, assigned_by: null });
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: created.user.email, options: { redirectTo: 'http://localhost:3000/auth/callback' } });
  return { userId: created.user.id, actionLink: link.properties.action_link };
}
// teardown: admin.from('admin_users').delete().eq('user_id', id); admin.from('resource_user_roles').delete().eq('user_id', id); admin.auth.admin.deleteUser(id);
```

A full 9-role pass additionally needs Editor, Compliance Reviewer, Publisher, and Resource Admin fixtures (same pattern, different `role` value) and a plain authenticated-but-role-less user (no `admin_users` row, no `resource_user_roles` row).

## 4. Entry gate for A3

Per `A1_20`: "A2 exit gate: 8-area nav renders correctly for all 8 personas + role-less, zero regressions in the 9-caller-type matrix, Admin Home shows real queue data for at least the domains named in `A1_09` §2's 'exists' rows." All three are met by hermetic test evidence in this pass (see `A2_09_TEST_AND_REGRESSION_REPORT.md`); the one named gap (live-DEV browser walkthrough) is an evidence gate, not a functional defect, and per dispatch's own CONDITIONAL PASS rules does not by itself block A3 from beginning — it blocks only the *live-verified* claim, which the Product Owner should weigh before authorizing any merge.

## 5. Recommendation

**A2 may not merge or deploy without explicit Product Owner authorization** (dispatch §31, unconditional regardless of verdict). Whether A3 may *begin* (as opposed to merge) is a Product Owner call informed by: the live-DEV evidence gap above, and the accessibility/responsive gap in `A2_07_ACCESSIBILITY_RESPONSIVE_CERTIFICATION.md`.
