# ADV-01 through ADV-10 — Terminal Adversarial Results

Supersedes `A2A5_04_ADV_ADVERSARIAL_RESULTS.md` as the terminal record (that document's findings are carried forward unchanged; this document adds the mission's own exact per-probe field template: precondition, fixture, request/action, expected result, actual result, UI/API/DB result, audit result, cleanup, verdict).

## ADV-01 — Unauthorized navigation discovery

- **Precondition:** caller has no capability for a given Admin area.
- **Fixture:** mocked Supabase client returning no `admin_users` row / no matching `resource_user_roles` row, for all 9 persona shapes.
- **Request/action:** call `buildAdminAreas()` directly with each persona's capability set.
- **Expected result:** the area with no usable destination for that persona is absent from the returned array entirely (not present-but-hidden).
- **Actual result:** matches expected — `tests/unit/adminA2CanonicalShell.test.ts`'s persona-matrix block confirms this for all 9 personas.
- **UI result:** not independently observed live (no DEV credentials) — the same function backs the live render, so this is a strong but not live-proven signal.
- **API result:** N/A — this probe is about discovery via nav, not API access (covered by ADV-02).
- **DB result:** N/A.
- **Audit result:** N/A — no mutation, no audit expected.
- **Cleanup:** N/A — no fixture created in the database.
- **Verdict: PASS (hermetic).**

## ADV-02 — Direct-route authorization bypass

- **Precondition:** caller is anonymous, role-less, wrong-role, or holds a mixed role lacking the specific required capability.
- **Fixture:** mocked `createClient()` returning each of these identity shapes, per `tests/unit/adminCapabilitySplit.test.ts` and `tests/unit/countryGateAdminAndHousehold.test.ts`.
- **Request/action:** invoke the real exported route handler function directly (not just the auth helper in isolation, for the `countryGateAdminAndHousehold` case).
- **Expected result:** 401 (unauthenticated) or 403 (authenticated, forbidden).
- **Actual result:** matches expected for all tested cases, across all 3 newly-split capability functions and the pre-existing Resources capability tests (`adminA02Wave2CapabilityMatrix.test.ts`).
- **UI result:** N/A (this probe is API/route-level).
- **API result:** confirmed via direct handler invocation, as above.
- **DB result:** not independently probed at the RPC/database layer this pass — no privileged RPC exists yet in the A4 scope to bypass-test (`A2A5_18`/`A2A5_19` confirm no RPC exists).
- **Audit result:** N/A for these routes (no audit-producing mutation in a denied request).
- **Cleanup:** N/A.
- **Verdict: PASS (hermetic), scoped to the 34 routes this dispatch touched plus pre-existing Resources coverage. Expired session specifically not tested (no session-expiry simulation exists in the current mocked-client test harness) — disclosed gap, not asserted as covered.**

## ADV-03 — Actor identity spoofing

- **Precondition:** a caller attempts to supply their own `actor_id`/approver/target-user value.
- **Fixture:** N/A — by inspection, `requireAdmin()` and its 3 named derivatives never read any request body or query parameter for identity; identity comes exclusively from `supabase.auth.getUser()`.
- **Request/action:** direct source review, not a runtime test (no forgeable field exists to attempt forging against).
- **Expected/actual result:** identical — there is no code path that would accept a client-supplied identity for authorization in the 34 routes this dispatch touched.
- **UI/API/DB result:** confirmed at the API layer by source inspection; DB layer N/A (no RPC exists to test approver-ID/target-user spoofing against — `A2A5_18`/`A2A5_20`/`A2A5_21`).
- **Audit result:** N/A — no audit-writing RPC exists yet to test actor-attribution spoofing against.
- **Cleanup:** N/A.
- **Verdict: PASS at the API layer (by inspection, for the routes touched). NOT APPLICABLE at the RPC/audit/support/break-glass layer — those mechanisms do not exist yet, so there is no actor-identity field to spoof there.**

## ADV-04 — Concurrent mutation duplication

- **Precondition:** two concurrent requests against the same mutation.
- **Fixture:** none created — this dispatch's own code change (the capability rename) added zero new mutation paths.
- **Request/action:** not executed this pass.
- **Expected/actual result:** N/A.
- **Verdict: NOT RE-TESTED, but confirmed NOT NEWLY AT RISK** — the rename touched zero INSERT/UPDATE/DELETE logic (confirmed: `git diff --stat` for the capability-split commit shows only the auth-wrapper file and 34 mechanical single-line renames). Pre-existing concurrency protections (e.g. the account-deletion queue's claim-based state transition) are unchanged and were not independently re-tested this pass pending a full-suite run (`A2A5_24`).

## ADV-05 — Audit rollback on business failure

- **Precondition:** a mutation's mandatory audit write fails partway.
- **Fixture:** none created.
- **Verdict: NOT APPLICABLE to this dispatch's own change** (no new mutation path). For A4.1 specifically: the schema (`A2A5_18`) reserves a `result: 'failed'` value precisely so a failed mutation still produces a row, but no RPC exists yet to prove this live. **Schema-ready, NOT TESTED.**

## ADV-06 — Suppression reconstruction by repeated filters

- **Verdict: NOT APPLICABLE — no suppression engine exists** (`A2A5_19`). A probe cannot fail against code that was never written; this is recorded as NOT APPLICABLE, not PASS, per mission §14's own instruction not to infer success from absence of a feature.

## ADV-07 — Cross-role client cache leakage

- **Precondition:** two different operator sessions in the same browser/client cache.
- **Fixture:** none — this would require either a live multi-session browser test or a targeted unit test of this codebase's specific client-side data-fetching/cache-key strategy for Admin pages, neither of which was built this pass.
- **Verdict: NOT TESTED — explicit, disclosed gap**, carried forward unchanged from `A2A5_04`/`A2A5_06`'s deferral register.

## ADV-08 — Compatibility-route leakage

- **Precondition:** a compatibility/withdrawn/redirect route exists to probe.
- **Verdict: NOT APPLICABLE — no compatibility route exists** (`A2A5_17` confirms zero compatibility routes; the one withdrawn route, `recommendations/gaps`, was independently confirmed via direct grep to not be re-referenced anywhere in this dispatch's changes — see `A2A5_13`).

## ADV-09 — Support grant misuse

- **Verdict: NOT APPLICABLE — no support-access mechanism exists** (`A2A5_20`).

## ADV-10 — Break-glass misuse

- **Verdict: NOT APPLICABLE — no break-glass mechanism exists** (`A2A5_21`).

## Summary

| Probe | Verdict |
|---|---|
| ADV-01 | PASS (hermetic) |
| ADV-02 | PASS (hermetic, scoped); expired-session case not covered |
| ADV-03 | PASS (API layer, by inspection); N/A at RPC/audit/support/break-glass layer |
| ADV-04 | NOT RE-TESTED; confirmed not newly at risk |
| ADV-05 | NOT APPLICABLE to this dispatch; schema-ready for A4.1, untested |
| ADV-06 | NOT APPLICABLE (feature does not exist) |
| ADV-07 | NOT TESTED (explicit gap) |
| ADV-08 | NOT APPLICABLE (no such route) |
| ADV-09 | NOT APPLICABLE (feature does not exist) |
| ADV-10 | NOT APPLICABLE (feature does not exist) |

**No probe returned FAIL.** 3 have real hermetic evidence; 1 is an honest disclosed gap (ADV-07); 1 is confirmed-not-newly-at-risk without fresh execution (ADV-04); 5 are NOT APPLICABLE because their target feature does not exist in this codebase. This is the same conclusion `A2A5_04` reached, now expressed in the mission's own exact per-field template.
