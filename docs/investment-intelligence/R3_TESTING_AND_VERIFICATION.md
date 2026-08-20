# R3 — Testing and Verification

Status: FINAL (R3), UPDATED 2026-08-20 after migration `0042` was applied to DEV and the live closure pass completed (see `R3_ACCEPTANCE_REPORT.md` section 0). Every claim below is labeled STATIC / FIXTURE-UNIT / LOCAL-DB / LIVE-DEV / MANUAL-ADVERSARIAL explicitly, per this project's own discipline. Nothing is claimed LIVE unless it was actually run against a live environment.

## 1. Summary

| Layer | Status | Count |
|---|---|---|
| STATIC (tsc, lint, build) | RUN, real output below | — |
| FIXTURE/UNIT (pure logic + engine-level, in-memory) | RUN, real output below | 106 new tests |
| Pre-existing regression (R1/R2 + rest of app) | RUN, real output below | 364 tests, unchanged |
| LOCAL-DB / LIVE-DEV (against the real live schema) | **RUN** — migration `0042` applied 2026-08-20; the critical duplicate scenario, refresh, unpublish, republish, and idempotency (sequential + genuine concurrency) all independently verified via real HTTP requests + service-role ground-truth reads | See section 8 |
| MANUAL-ADVERSARIAL (SEC-R3) | **RUN** — 12/12 checks PASS with real seeded victim data | See `R3_SECURITY_VERIFICATION.md` section 6 |

## 2. STATIC verification (real commands, real output)

```
npx tsc --noEmit          -> clean, 0 errors
npx eslint .               -> 6 errors, 6 warnings (identical to documented pre-existing baseline)
npm run build               -> succeeds, 161 routes incl. all new R3 routes
```

## 3. FIXTURE/UNIT test packs — run for real, exact results

### `tests/unit/iiR3PublicationLogic.test.ts` — 59 tests, all PASS
Covers: production-scope gate, ITEM/OWNER/COST BASE/RISK BAND/ANNUAL CONTRIBUTION mapping, the full eligibility gate (every blocking/warning reason individually and in combination), duplicate-candidate detection (DD-005, DD-032, institution-required-signal rule, owner-mismatch-not-a-duplicate), financial-impact exact arithmetic (NW-001/002, the spec's own worked example), register-action classification, refresh/republish ordering (PUB-DEDUP-006/007), cross-border currency (CUR-001/002/003/006, DD-009), idempotency-key determinism.

### `tests/unit/iiR3NetWorthCertification.test.ts` — 19 tests, all PASS
NW-001 through NW-008 and FIN-001/002/003/004/010, run through the **real, unmodified** `computeDashboard()`. Includes a genuine mutation test: constructs the exact FAIL-condition bug (a second `investments` row inserted for an already-published position) and confirms the assertion that would catch it actually fails on the buggy input (`netWorth=1,020,000`, matching the spec's own named failure value) while passing on the correct input (`netWorth=520,000`) — proving the test is not vacuous.

### `tests/unit/iiR3DedupScenarioMatrix.test.ts` — 17 tests, all PASS
All 12 R0 scenarios (DD-001 through DD-012), each individually asserted; production scenarios (DD-004, DD-005, DD-009, DD-010, DD-011, DD-012) assert real behaviour, structural scenarios (DD-001/002/003/006/007/008) assert correct routing/gating without claiming production activation.

### `tests/unit/iiR3ManualReconciliation.test.ts` — 11 tests, all PASS
Spec section 77's manual reconciliation pack: 10 required cases + 1 bonus, each with hand-worked arithmetic in the test's own comment, compared against `computeDashboard()`'s real output. Classified as **ENGINE-LEVEL** reconciliation (the real calculation function, in-memory inputs) — not a full live-app HTTP/UI walkthrough, which the migration-application block makes impossible in this sandbox.

**Total new: 106 tests, 106 passing.**

## 4. Regression — full suite

```
npx vitest run
 Test Files  37 passed (37)
      Tests  470 passed (470)
```

364 of these are the exact pre-existing R1/R2 suite (confirmed identical count to R2's documented baseline after fixing a pre-existing, unrelated environment gap — see section 6). 106 are new R3 tests. **Zero pre-existing tests were modified.**

## 5. What was BLOCKED, and is now closed (2026-08-20)

As of the original R3 implementation pass, `investmentPublicationService.ts` (the DB-touching orchestration layer) could not be exercised end-to-end — no Supabase CLI project link, no direct Postgres connection string, and no DDL execution capability even via the service-role client, which could only reach whatever schema already existed on DEV (not yet including any R3 column/table/constraint).

**Migration `0042` was applied to DEV on 2026-08-20** (Product Owner action, independently confirmed via direct REST probes). The live closure pass that followed (`R3_ACCEPTANCE_REPORT.md` section 0) closed every item this section previously listed as BLOCKED:
- `uidx_ii_fhip_publications_one_active_position` — **now LIVE-CONFIRMED**: a genuine concurrent (`Promise.all`) duplicate publish request resulted in exactly one active row; the refresh-ordering bug that would have violated this constraint on every real refresh attempt was found and fixed specifically because this constraint fired for real during testing.
- `PUB-001` through `PUB-012`, `PUB-DEDUP-001` through `PUB-DEDUP-010` — the critical scenarios (PUB-005 first publish, PUB-008 refresh, PUB-009 unpublish, PUB-010 republish, PUB-012 concurrent idempotency, PUB-DEDUP's manual/imported duplicate linking) are now **LIVE-CONFIRMED** end to end via real HTTP requests against the real API routes. See the updated cross-reference table in section 7.
- `SEC-R3-001` through `SEC-R3-010` — **12/12 LIVE PASS** (`R3_SECURITY_VERIFICATION.md` section 6).
- Live concurrency (concurrent publish+publish) — **LIVE-CONFIRMED** via genuine `Promise.all` racing against the real API.

**What remains genuinely not exercised in this pass** (narrow, disclosed, non-blocking):
- Concurrent publish+unpublish and refresh+refresh races specifically (only concurrent publish+publish was fired) — the underlying idempotency-key/compensating-state mechanism is the same one already live-proven for publish+publish, but the exact interleaving was not separately reproduced.
- A live PATCH attempt against a published row using the row's OWNER's own session (only a cross-user PATCH attempt, SEC-R3-008, was exercised) — the direct-edit-protection logic itself is unit-tested (DD-012 suite) and code-reviewed.
- Deliberate mid-write failure injection (killing the process between the two writes of a publish) to observe the compensating-state rollback fire live — the rollback CODE PATH is unit-reviewed and one real failure (the `pdf-parse` worker bug, R2-side) was observed to leave zero orphaned rows, but this was incidental, not a deliberately engineered failure-injection test.

## 6. Pre-existing environment gap found and fixed (not an R3 regression)

Before R3 work began, `npx vitest run` reported 357/358 (one suite failed to load: `tests/unit/iiR2PdfExtraction.test.ts`, `Cannot find package 'pdf-parse'`). This traced to the shared `node_modules` junction (`D:\FHIP\node_modules`, linked into this worktree per the standard setup step) missing a package already declared in `package.json` (`pdf-parse@^2.4.5`) — an installation gap unrelated to any code change, pre-dating this session. Running `npm install pdf-parse@^2.4.5 --no-save` against the shared `node_modules` (not `package.json`/`package-lock.json`, which are untouched) restored the documented R2 baseline of exactly 364/364. This is disclosed here rather than silently worked around, per this project's standing discipline about test-harness artifacts.

## 7. Cross-reference: literal spec test IDs vs. where their logic is actually covered (updated 2026-08-20)

| Spec ID | Covered by (FIXTURE/UNIT) | Live-API status |
|---|---|---|
| PUB-001 certified eligible | `evaluateEligibility` "is ELIGIBLE" test | **LIVE PASS** — real certify + eligibility gate cleared for the real position |
| PUB-002 uncertified blocked | `evaluateEligibility` "NOT_ELIGIBLE for uncertified" test | Not separately live-fired (no uncertified live position was attempted this pass) |
| PUB-003 owner unresolved blocked | `evaluateEligibility` "OWNER_UNRESOLVED" test | Not separately live-fired (the test household's owner was always resolved) |
| PUB-004 target resolved correctly | `computePublicationTarget` routing tests | **LIVE PASS** — routed to `investments`, confirmed via the real published row |
| PUB-005 first publish successful | NW-001 (real engine) | **LIVE PASS** |
| PUB-006 source metadata retained | `R3_FHIP_MAPPING_SPEC.md` field-by-field, migration column review | **LIVE PASS** — real `source_currency`/`source_country`/`published_value` etc. confirmed on the real row |
| PUB-007 published row protected from direct edit | direct-edit-protection field list test (`DD-012` suite) + code review | **LIVE PASS (partial)** — SEC-R3-008 live-confirmed a cross-user PATCH is rejected; the row-owner's-own-session PATCH-of-a-protected-field case was not separately live-fired |
| PUB-008 refresh updates active publication | `decideRefreshSupersession` tests + NW-003 | **LIVE PASS** — after fixing the refresh-ordering defect found by this exact test |
| PUB-009 unpublish works | NW-004 | **LIVE PASS** — after fixing the silent-restore-failure defect found by this exact test |
| PUB-010 republish works | NW-005 | **LIVE PASS** |
| PUB-011 audit complete | audit event type list reviewed + every `emitAuditEvent()` call site reviewed | Not independently re-queried live this pass (the writes execute via the same service-role path already confirmed working for R1/R2 audit events) |
| PUB-012 concurrent publish idempotent | idempotency-key determinism test + NW-006 mutation test | **LIVE PASS** — genuine `Promise.all` concurrent publish confirmed via direct DB query |
| PUB-DEDUP-001..010 | `iiR3DedupScenarioMatrix.test.ts` + `iiR3PublicationLogic.test.ts` duplicate-detection suite | **LIVE PASS for the critical scenario** (manual 500,000 + certified 520,000 → exactly one row at 520,000) |
| FIN-001..010 | `iiR3NetWorthCertification.test.ts`, `iiR3ManualReconciliation.test.ts` | Engine-level only (unchanged) — computeDashboard() itself was not re-run against the live rows this pass, but the live rows' values were confirmed correct by direct query, and the engine is proven correct against equivalent in-memory data |
| CUR-001..006 | `iiR3PublicationLogic.test.ts` currency suite, `R3_CROSS_BORDER_PUBLISHING.md` | Not live-fired this pass (the live test household was INR-only; no AUD household was exercised live) |
| SEC-R3-001..010 | none (requires live seeded victim rows) | **12/12 LIVE PASS** — see `R3_SECURITY_VERIFICATION.md` section 6 |

## 8. Live-DEV closure pass — full detail

See `R3_ACCEPTANCE_REPORT.md` section 0 for the complete methodology, the four prerequisites and their results, and the six real defects found and fixed. Scripts used (temporary, deleted after this pass per the cleanup discipline every closure pass in this project follows): `scripts/r3_closure_setup.ts`, `scripts/r3_lib_auth.mjs`, `scripts/r3_closure_live_tests.mjs`, `scripts/r3_closure_live_tests_part2.mjs`, `scripts/r3_sec_tests.mjs`, `scripts/r2_closure_live_tests.mjs`, `scripts/r3_pdf_gen.mjs`, `scripts/r3_cleanup.mjs`.
