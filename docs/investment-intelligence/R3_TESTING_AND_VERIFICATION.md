# R3 — Testing and Verification

Status: FINAL (R3). Every claim below is labeled STATIC / FIXTURE-UNIT / LOCAL-DB / LIVE-DEV / MANUAL-ADVERSARIAL explicitly, per this project's own discipline. Nothing is claimed LIVE unless it was actually run against a live environment.

## 1. Summary

| Layer | Status | Count |
|---|---|---|
| STATIC (tsc, lint, build) | RUN, real output below | — |
| FIXTURE/UNIT (pure logic + engine-level, in-memory) | RUN, real output below | 106 new tests |
| Pre-existing regression (R1/R2 + rest of app) | RUN, real output below | 364 tests, unchanged |
| LOCAL-DB (against the new schema) | **BLOCKED** — migration not applied in this sandbox | 0 (documented, not fabricated) |
| LIVE-DEV | **BLOCKED** — same reason | 0 |
| MANUAL-ADVERSARIAL (SEC-R3) | **BLOCKED** — same reason | 0 (methodology documented in `R3_SECURITY_VERIFICATION.md`) |

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

## 5. What is genuinely BLOCKED (and why this is honest, not a shortcut)

`investmentPublicationService.ts` (the DB-touching orchestration layer) cannot be exercised end-to-end without either a live Supabase connection to a database with migration `0042` applied, or a substantial hand-built mock of Supabase's fluent query builder. This sandbox has neither: no Supabase CLI project link, no direct Postgres connection string, and (per the standing constraint every prior phase disclosed identically) no DDL execution capability even via the available service-role client — the service-role client can perform real REST-API reads/writes, but only against whatever schema **currently exists** on DEV, which does not yet include any R3 column/table/constraint.

Consequently, the following are explicitly **not** claimed as passing, run, or verified — they are BLOCKED:
- Any test asserting `uidx_ii_fhip_publications_one_active_position` actually rejects a concurrent duplicate INSERT at the database level (the constraint's SQL is written and reviewed; its live enforcement is unverified).
- `PUB-001` through `PUB-012`, `PUB-DEDUP-001` through `PUB-DEDUP-010` in their literal live-API-request form (the pure-logic equivalents of most of these ARE covered by section 3's tests — see the cross-reference table below — but a literal `POST /api/investment-intelligence/positions/[id]/publish` HTTP round-trip against a real database was not performed).
- `SEC-R3-001` through `SEC-R3-010` (see `R3_SECURITY_VERIFICATION.md`).
- Live concurrency tests (concurrent publish+publish, publish+unpublish, refresh+refresh) — the compensating-state/idempotency-key logic is written and its DECISION LOGIC is unit-tested, but a genuine race condition against a live database was not producible in this sandbox.

## 6. Pre-existing environment gap found and fixed (not an R3 regression)

Before R3 work began, `npx vitest run` reported 357/358 (one suite failed to load: `tests/unit/iiR2PdfExtraction.test.ts`, `Cannot find package 'pdf-parse'`). This traced to the shared `node_modules` junction (`D:\FHIP\node_modules`, linked into this worktree per the standard setup step) missing a package already declared in `package.json` (`pdf-parse@^2.4.5`) — an installation gap unrelated to any code change, pre-dating this session. Running `npm install pdf-parse@^2.4.5 --no-save` against the shared `node_modules` (not `package.json`/`package-lock.json`, which are untouched) restored the documented R2 baseline of exactly 364/364. This is disclosed here rather than silently worked around, per this project's standing discipline about test-harness artifacts.

## 7. Cross-reference: literal spec test IDs vs. where their logic is actually covered

| Spec ID | Covered by (FIXTURE/UNIT) | Live-API equivalent |
|---|---|---|
| PUB-001 certified eligible | `evaluateEligibility` "is ELIGIBLE" test | BLOCKED |
| PUB-002 uncertified blocked | `evaluateEligibility` "NOT_ELIGIBLE for uncertified" test | BLOCKED |
| PUB-003 owner unresolved blocked | `evaluateEligibility` "OWNER_UNRESOLVED" test | BLOCKED |
| PUB-004 target resolved correctly | `computePublicationTarget` routing tests | BLOCKED |
| PUB-005 first publish successful | NW-001 (real engine) | BLOCKED |
| PUB-006 source metadata retained | `R3_FHIP_MAPPING_SPEC.md` field-by-field, migration column review | BLOCKED |
| PUB-007 published row protected from direct edit | direct-edit-protection field list test (`DD-012` suite) + code review of `app/api/investments/[id]/route.ts` | BLOCKED (live PATCH attempt) |
| PUB-008 refresh updates active publication | `decideRefreshSupersession` tests + NW-003 | BLOCKED |
| PUB-009 unpublish works | NW-004 | BLOCKED |
| PUB-010 republish works | NW-005 | BLOCKED |
| PUB-011 audit complete | audit event type list reviewed in migration `0042` + every service function's `emitAuditEvent()` call sites reviewed | BLOCKED (live insert) |
| PUB-012 concurrent publish idempotent | idempotency-key determinism test + NW-006 mutation test | BLOCKED (live race) |
| PUB-DEDUP-001..010 | `iiR3DedupScenarioMatrix.test.ts` + `iiR3PublicationLogic.test.ts` duplicate-detection suite | BLOCKED |
| FIN-001..010 | `iiR3NetWorthCertification.test.ts`, `iiR3ManualReconciliation.test.ts` | BLOCKED |
| CUR-001..006 | `iiR3PublicationLogic.test.ts` currency suite, `R3_CROSS_BORDER_PUBLISHING.md` | BLOCKED |
| SEC-R3-001..010 | none (requires live seeded victim rows) | BLOCKED — see `R3_SECURITY_VERIFICATION.md` |

This table is deliberately explicit about which spec-named test IDs have a genuine FIXTURE-level proof today versus which remain BLOCKED — nothing in the left two columns is claimed LIVE.
