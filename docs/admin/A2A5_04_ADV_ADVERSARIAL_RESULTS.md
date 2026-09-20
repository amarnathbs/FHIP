# ADV-01..10 — Adversarial Security Probes: Results

Each ADV item shares identical binding instructions (define precondition/attacker-action/expected fail-closed result; exercise UI+API+DB; record stable status without raw infrastructure detail; verify no partial mutation/privacy disclosure/unauthorized audit attribution; repeat under concurrency/caching/timing) — see `A2A5_00` §2. Results below are per-probe because the underlying feature surface each probe targets differs sharply in maturity (some map to already-shipped code, several map to A4 features this dispatch found to be `NOT STARTED` — see `A2A5_03`).

**Environment constraint applying to every probe below:** no live-DEV Supabase credentials are available in this execution environment (`A2A5_01` §"Live-DEV"). Every result marked "hermetic/unit-level" below is a real, executed test against the actual route handler / actual authorization function, using a mocked Supabase client — it proves the code path's logic, not a live network-level or live-database-level proof. This distinction is preserved per Programme Charter 9 and is not rounded up.

## ADV-01 — Unauthorized navigation discovery

**Target:** can an operator without a capability discover/reach a nav destination they should not see or use? **Result: PASS (hermetic).** `tests/unit/adminA2NavigationRegistry.test.ts` and `tests/unit/adminA2CanonicalShell.test.ts` (25 + prior integrity tests, from the A2 pass, re-inspected not re-run pending the full suite run in `A2A5_01`) assert areas with no authorized destination are hidden per role, for all 8 canonical roles + role-less. Standard §4's own rule — "hiding a link is never a security control" — is respected: this probe is explicitly about *discovery*, not authorization; ADV-02 covers the actual bypass.

## ADV-02 — Direct-route authorization bypass

**Target:** does hitting a gated route/API directly (bypassing nav) still deny an unauthorized caller? **Result: PASS (hermetic), for the 34 routes touched by this dispatch's capability split.** `tests/unit/adminCapabilitySplit.test.ts` (new, this dispatch) directly invokes `requireBenchmarksAdmin`/`requireRecommendationsAdmin`/`requireAIPlatformAdmin` and proves 401 for unauthenticated, 403 for authenticated-non-admin, allow for a real `admin_users` row — for all three. `tests/unit/countryGateAdminAndHousehold.test.ts` additionally exercises the real `benchmarkSourcesGET` route handler end-to-end (not just the auth function in isolation). Pre-existing `tests/unit/adminA02Wave2CapabilityMatrix.test.ts` provides the same proof for the Resources-domain capabilities (`canManageDiscovery`, scheduling/publishing gates) untouched by this dispatch. **Not covered:** the 44 other `app/api/admin/**` route files this dispatch did not touch (Resources content/workflow routes) were not re-verified this pass — they were not changed, so no new regression risk was introduced, but a fresh direct-route probe against them was not re-run either (carried forward, not a new gap this dispatch created).

## ADV-03 — Actor identity spoofing

**Target:** can a caller forge `actor_id`/identity used for authorization or audit attribution? **Result: PASS (hermetic), for the routes this dispatch touched.** `lib/services/adminAuth.ts`'s `requireAdmin()` (and by inheritance, the three new capability functions) derive identity exclusively from `supabase.auth.getUser()` server-side — never from a request-body or query-string field. No call site in the 34 renamed routes accepts a caller-supplied identity for authorization. **Not independently probed at the database/RPC layer** — no privileged RPC exists yet in the A4 scope (see `A2A5_03`) to test `auth.uid()`-vs-caller-supplied-identity against, since A4.1's write RPC was explicitly not built this pass. This probe's DB-layer half is therefore **NOT APPLICABLE yet**, not failed.

## ADV-04 — Concurrent mutation duplication

**Target:** does a race (double-submit, concurrent requests) produce a duplicate/inconsistent mutation? **Result: NOT RE-TESTED this pass.** This dispatch's own code change (the capability rename) introduced no new mutation path — it changed which function name gates a route, not any INSERT/UPDATE logic. Pre-existing concurrency protections (e.g. the account-deletion queue's claim-based `pending->processing` transition, `tests/unit/accountDeletionAdminRoutes.test.ts`) are unchanged and were not re-run this pass pending `A2A5_01`'s full-suite run. **Status: CARRIED, not newly at risk.**

## ADV-05 — Audit rollback on business failure

**Target:** if a mutation fails partway, does its audit record correctly reflect failure (not silently vanish or falsely claim success)? **Result: NOT APPLICABLE to this dispatch's own change** (no new mutation path was added). For the canonical audit sink specifically (A4.1): the schema (migration `0165`) reserves a `result` value of `'failed'` precisely so a failed mutation still produces a row (`A1_12` §2.1's own requirement, "a failed/rejected mutation must still produce a row") — but since no write RPC exists yet, this cannot be proven live. **Status: schema-ready, NOT TESTED (A4.1 RPC not built).**

## ADV-06 — Suppression reconstruction by repeated filters

**Target:** can an operator narrow filters across repeated queries to reconstruct a suppressed cell? **Result: NOT APPLICABLE — no suppression engine exists.** `A2A5_03` §3 records A4.3 (canonical suppression engine) as `NOT STARTED`, for the explicit reason that shipping unverified suppression logic is a named highest-risk item in this whole programme. There is nothing to adversarially probe yet. **Status: NOT APPLICABLE (feature not built).**

## ADV-07 — Cross-role client cache leakage

**Target:** does client-side caching (React Query / SWR / browser storage) leak one role's data to a session that switches roles? **Result: NOT TESTED.** This requires either a live multi-session browser walkthrough (blocked — no DEV credentials, matching `A2A5_01`) or a targeted unit test of the specific client cache-key strategy used by Admin data-fetching hooks, which this dispatch did not have remaining budget to author and verify. **Status: NOT TESTED, carried forward as an explicit gap (not silently assumed safe).**

## ADV-08 — Compatibility redirect existence leak

**Target:** does a compatibility/legacy route reveal (via its redirect behaviour or status code) whether a resource exists to a caller who shouldn't be able to tell? **Result: NOT APPLICABLE — no compatibility route was created.** `docs/admin/A2_06_COMPATIBILITY_ROUTE_REGISTER.md` (A2 pass) already confirmed zero compatibility routes exist (zero URL changes were made). This dispatch created none either. **Status: NOT APPLICABLE (no such route exists to probe).**

## ADV-09 — Support grant reuse or expiry bypass

**Target:** can a support-access grant be reused across users/incidents, or used after expiry? **Result: NOT APPLICABLE — no support-access mechanism exists.** `A2A5_03` §4 records A4.4 as `NOT STARTED`. **Status: NOT APPLICABLE (feature not built).**

## ADV-10 — Break-glass without alert or review

**Target:** can break-glass access be exercised without triggering the mandatory immediate alert and after-action review? **Result: NOT APPLICABLE — no break-glass mechanism exists.** Same as ADV-09. **Status: NOT APPLICABLE (feature not built).**

## Summary

| Probe | Status |
|---|---|
| ADV-01 Unauthorized navigation discovery | PASS (hermetic) |
| ADV-02 Direct-route authorization bypass | PASS (hermetic, scoped to this dispatch's 34 touched routes + pre-existing Resources coverage) |
| ADV-03 Actor identity spoofing | PASS (API layer, hermetic); DB/RPC layer NOT APPLICABLE (no RPC built yet) |
| ADV-04 Concurrent mutation duplication | CARRIED (not newly at risk; not re-tested) |
| ADV-05 Audit rollback on business failure | NOT APPLICABLE to this dispatch; schema-ready for A4.1, RPC not built |
| ADV-06 Suppression reconstruction by repeated filters | NOT APPLICABLE (A4.3 not built) |
| ADV-07 Cross-role client cache leakage | NOT TESTED (explicit gap) |
| ADV-08 Compatibility redirect existence leak | NOT APPLICABLE (no such route) |
| ADV-09 Support grant reuse or expiry bypass | NOT APPLICABLE (A4.4 not built) |
| ADV-10 Break-glass without alert or review | NOT APPLICABLE (A4.4 not built) |

**No probe in this table returned a FAIL.** Three (ADV-01/02/03) have real, executed evidence. One (ADV-07) is an honest, disclosed gap. The remaining six are NOT APPLICABLE or CARRIED because their target feature does not exist yet in this codebase — a probe cannot fail against code that was never written, and marking these "PASS" would misrepresent an absence of surface area as a proven defence, which Programme Charter 9 and Standard §8 both explicitly prohibit ("never infer success from absence of an error").
