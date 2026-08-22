# R0 — Security / RLS Architecture

Status: FINAL (R0) — freezes R1 requirements only. **No RLS policy is implemented in R0.**
Depends on: `R0_CURRENT_STATE_DISCOVERY.md` (section 10 — existing access model verified against actual migrations)

## 1. How existing household/member access actually works today

Verified, not assumed (`R0_CURRENT_STATE_DISCOVERY.md` section 10):

- **Row ownership**: every user-owned table has exactly one RLS policy, `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`. There is no read/write policy split anywhere in the registers inspected.
- **Household access**: `households` is a single-owner metadata row (`user_id`), not a multi-member entity with its own membership/roles table.
- **"Family-member" access**: `household_members` rows are reference data (name, relationship, DOB) used to *tag* a goal's owner/beneficiary — they are not a second authenticated principal, do not have their own `auth.users` row, and cannot independently log in and see "their" household's data. **FHIP has no working multi-person household access model today.** This is a material, confirmed gap, not an assumption.
- **Admin access**: gated through `admin_users` (itself RLS-scoped so a user can only read their own flag — no self-service admin grant path) plus `requireAdmin()`/`adminRoute()` (`lib/services/adminAuth.ts`) wrapping the service-role client (`lib/supabase/admin.ts`). This is a real, working, least-privilege pattern already proven in production (Module 8's benchmark governance).
- **Service-role access**: used only for (a) genuinely cross-user server jobs (e.g. the scheduled report-generation cron) and (b) admin routes gated by `requireAdmin()` — never exposed to a request path that hasn't independently verified the caller.
- **Storage access**: the one bucket found (`report-exports`) is private, service-role-write, signed-URL-read only (`R0_CURRENT_STATE_DISCOVERY.md` section 9).
- **No client-side-only filtering** is relied on anywhere inspected — every list/read still goes through the RLS-respecting `createClient()`.

## 2. R1 security requirements (frozen)

### Row ownership
Every `ii_*` user-owned entity (`R0_CANONICAL_DATA_CONTRACT.md`'s per-entity RLS column) uses the **identical** owner-only policy pattern already proven across every existing FHIP table — no new policy shape is introduced. This is a deliberate consistency choice: Investment Intelligence should not be the one module with a different RLS idiom from the rest of the platform.

### Household access
Because no real multi-person household access model exists today, Investment Intelligence's R1 implementation **must not assume one**. Every `ii_*` table's RLS boundary is the same single `user_id` boundary as everything else — "household" in Investment Intelligence's data model is a *reference concept* (via `household_members`, for owner tagging) exactly as it already is in Goals, not a genuine multi-principal access boundary. If/when FHIP builds real multi-person household authentication, Investment Intelligence's RLS would need to move to a household-scoped policy at that time, alongside every other module — this is flagged as a **platform-wide** prerequisite, not something Investment Intelligence should attempt to solve alone or first.

### Family-member access
Not implementable in R1 for the reason above — no family member has their own login today. Deferred until the platform-wide gap is closed.

### Adviser/CA future access
Not built in R0/R1 (explicitly out of scope — spec non-goals: "Do not create adviser features"). The architecture reserves the shape for it (the `professional_access`/`permission_grant`/`permission_revoke` audit event types in `R0_AUDIT_REQUIREMENTS.md`, and `actor_type='professional'`), but no professional-access table, policy, or route is designed or built now. When it is built, it should follow the existing `admin_users`-style pattern: a separate, RLS-scoped grant table a user cannot self-escalate, checked explicitly before any service-role read, never a broadened RLS policy on the `ii_*` tables themselves.

### Service-role access
Reused exactly as today: source-document parsing (a background/server job, likely needing cross-row access during a single import) and any future scheduled reference-data refresh (NAV/benchmark ingestion) run through the service-role client, gated the same way `adminRoute()` gates admin actions today — never exposed to a browser-originated request without an equivalent explicit authorization check first.

### Source-document storage access
A new private bucket (e.g. `investment-source-documents`), service-role-write-only, signed-URL-read-only — identical mechanism to `report-exports` (`R0_CURRENT_STATE_DISCOVERY.md` section 9), not a new access model.

### Admin access
Reused exactly as today (`admin_users` + `requireAdmin()`), for reference-data curation (`ii_sources`, `ii_instruments` master-record merges, `ii_benchmarks`, `ii_tax_rule_versions`) — the same admin boundary already governs `master_financial_items`/`goal_types`/benchmark tables.

### Least privilege
No `ii_*` table is ever queried through the service-role client on a user-facing request path — every user-facing read/write goes through the RLS-respecting client, matching the existing platform-wide discipline (section 1).

### Revocation
Not currently modelled anywhere in FHIP beyond `consents.revoked_at` (unused today — `R0_CURRENT_STATE_DISCOVERY.md` section 2). R1's `permission_grant`/`permission_revoke` audit events (`R0_AUDIT_REQUIREMENTS.md`) establish the trail; the actual grant/revoke *mechanism* is deferred to whenever professional/adviser access is actually built (out of scope now).

### Audit
Every RLS-relevant action (grant, revoke, admin correction, service-role operation) must emit an `ii_audit_events` row per `R0_AUDIT_REQUIREMENTS.md` — security events are a strict subset of the general audit requirement, not a separate mechanism.

## 3. Explicit statement: no investment data relies on client-side filtering

Consistent with the existing platform-wide discipline (section 1), every R1 `ii_*` table read is specified to go through RLS-enforced Supabase queries. No Investment Intelligence UI/API design in this or any future release may fetch broader data and filter client-side "for convenience" — this is frozen as a hard R1 acceptance requirement, not a preference.

## 4. What R0 explicitly does not do

No RLS policy SQL is written. No `ii_*` table exists yet. This document freezes *requirements* the R1 migration's RLS policies must satisfy — verified in `R1_IMPLEMENTATION_SPEC.md`'s own security-test section before any such migration is considered complete.
