# AIE-1 (AI Document Extraction) — Consolidated Report, Phases 1.1–1.6

**Branch:** `integration/aie-1-release-candidate` (merged release candidate; individual phase branches listed per-phase below)
**Report date:** 2026-09-12

## Executive Summary

**AIE-1 integrated release candidate — CONDITIONAL PASS.** All phase branches are merged into `integration/aie-1-release-candidate`, but not into `main`. Production application functionality remains disabled and unauthorised.

| Phase | Current status | What is complete | Material remaining work |
|---|---|---|---|
| AIE-1.1 Shared Gateway | CONDITIONAL PASS | Shared AIE schema, RLS, intake, structural PDF validation, extraction, masking, schema registry, gateway, orchestration and unresolved-item foundation | Real malware scanner absent; retention/purge job absent; only mock AI provider tested; final production build evidence requires closure |
| AIE-1.2 Investment Adapter | CONDITIONAL PASS | Adapter implemented and merged; centralized acceptance dispatch fixed; canonical write delegates to existing II processing | Limited certified scope; only CAMS CAS has dedicated fixture; no live II canonical-write proof; masked-AI fallback not exercised; broader broker/non-Indian formats deferred |
| AIE-1.3 FDH Bank Adapter | CONDITIONAL PASS | Existing FDH PDF pipeline wrapped; centralized commit route and idempotency guard completed; migration 0145 added | No full live-DEV bank-statement corpus run; scanned/OCR and password-protected statements deferred; bank coverage remains limited to existing certified formats |
| AIE-1.4 Other Modules | CONDITIONAL PASS | Insurance adapter implemented and merged; parser-registration defect fixed; real DEV extraction, correction and canonical-write path substantially exercised | Post-0146 completion/idempotency rerun still required; no exact real-insurer layout certification; eight other candidate document classes remain deferred or prohibited |
| AIE-1.5 Review & Acceptance | CONDITIONAL PASS | Shared review backend/UI, typed corrections, revalidation, evidence reveal, acceptance gates and adapter dispatch implemented | PC5 integration not implemented; no bulk review; no post-acceptance undo workflow; accessibility tooling/manual certification incomplete; II/FDH review journeys not fully live-certified |
| AIE-1.6 Certification | CONDITIONAL PASS — NO PRODUCTION GO | Independent review caught genuine defects; compressed-PDF bypass fixed; integration defects found and fixed; production-certification plan prepared | Must rerun terminal certification after all remaining blockers close; real provider, retention, malware, accessibility, PC5 and controlled-rollout evidence remain missing |

**Note on these labels**: only AIE-1.6 is the actual certifying pass with authority to issue a verdict, and its own verdict was narrower and more qualified at the time it ran ("CONDITIONAL PASS for 1.1+Insurance(1.4)+review-UX(1.5) on real re-executed evidence; 1.2/1.3 paper-reviewed only, not runtime-verified" — see §6). The real merge (§8) subsequently exercised 1.2/1.3 together with everything else, narrowing that original gap considerably. The table above is a synthesis of where things stand today, not a re-run of AIE-1.6's own formal certification process per phase.

### Migration and deployment position

| Migration | Environment status |
|---|---|
| 0140–0145 | Applied to DEV and production |
| 0146 | Applied to DEV only |
| AIE application branch | Not merged to `main` |
| Production AIE flags | Not authorised for activation |
| Production application functionality | Inactive |
| Real production AIE documents | Not authorised |

Although 0140–0145 are present in production, they are currently dormant additive schema because the integration release candidate has not been merged into deployed `main`.

### Overall completion assessment

At an engineering implementation level, the six phases are substantially advanced. At a strict phase-certification level:

- **FULL PASS: 0 of 6**
- **CONDITIONAL PASS: 6 of 6**
- **Production GO: No**
- **Production authority: Not granted**

The full phase-by-phase detail, the real merge and its follow-up fixes, both live-DEV passes, and the honest outstanding-items list all follow below unchanged.

---

## 0. What AIE actually is

Encrypted tenant-scoped document quarantine → malware/MIME/PDF-structural validation → local/private text/table/OCR extraction → deterministic classifier/parser first → local PII masking → minimum-necessary masked low-cost AI fallback **only** for approved gaps → strict JSON-Schema validation of AI output → adapter-owned deterministic reconciliation → domain-owned canonical write (the AIE core never writes canonical financial data directly).

Binding cross-phase rules, verified against every phase below: no unmasked PII ever reaches a provider; only the shared gateway calls a provider; AI confidence never overrides deterministic reconciliation; PC5 is the single exception-truth (no module builds a second one); PC6 (NAV/benchmark/reference-market-data ingestion) stays completely separate from document interpretation.

---

## 1. AIE-1.1 — Shared Document Gateway

**Branch:** `feature/aie-1-1-document-gateway` (off `origin/main`), commit `cd2d4a2`, pushed.
**Status:** Implemented, tested. Not certified, not merged to `main`, not deployed.

Discovery-first: reused FDH-3's file-validation/state-machine/storage+audit patterns, the existing `pdf-parse` wrapper, existing PII pattern libraries (payslip privacy, PAN masking), and `lib/ai/providers/types.ts`'s generic error types — all cited file:line, nothing duplicated.

**Built:** migration `0140_aie1_1_shared_document_gateway.sql` (15 tables, RLS, cross-tenant trigger); `lib/aie/**` (state machine, validation, masking, fingerprinting, Zod-based schema registry, AI gateway + mock provider, classifier registry, reconciliation contract, DB repository, audit, orchestrator); `app/api/aie/**` (intake/status/unresolved-items routes, flag-gated OFF by default).

**Disclosed deviations:** Zod instead of `ajv` (house convention — zero `ajv` usage anywhere in this repo); no real malware/AV engine (same disclosed gap FDH-3 itself carries) — real PDF-structural heuristics (embedded JS/launch-actions/polyglot) implemented instead.

**Verified:** 62/62 new unit tests; `tsc --noEmit` zero new errors; eslint zero errors/warnings; full suite 6374 passed / 18 pre-existing-confirmed failures. Two real regressions this branch caused were found and fixed, not swept under the rug (`appCapabilityManifest.test.ts` allowlist; `fdh1Isolation.test.ts` false-positive exception list). Both migration-collision guards clean. `next build` could not be completed — a genuine Turbopack/worktree symlinked-`node_modules` limitation, disclosed rather than hidden.

---

## 2. AIE-1.2 — Investment Intelligence Adapter

**Branch:** `feature/aie-1-2-investment-adapter` (off 1.1), commit `5ac527e`, pushed.
**Status:** Implemented, tested. Not certified/merged/deployed at the time.

Reused unmodified (cited file:line): II's parser registry, account/scheme resolution, fingerprinting, reconciliation (the same formula production's `evaluatePositionAndCertify` uses), decimal handling, and — critically — `documentProcessing.ts`'s `processSourceDocument()` for the actual canonical write, called unmodified rather than reimplemented.

**Certified document classes:** CAMS CAS, KFintech CAS, CAMS individual Folio Details statement. **Explicitly deferred:** broker/demat contract notes, non-Indian statements, PMS/NPS.

**Built:** migration `0141` (provenance-link table, RLS SELECT-only); `lib/aie/adapters/investment-intelligence/` (10 files); flag `AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED` default OFF; 42 new tests.

**Verified:** tsc/eslint clean, 42/42 new tests, zero regression on AIE+II existing suites (1728/1728), full suite 6416 passed. **Disclosed gaps:** masked-AI fallback architected but never exercised; `write.ts` only unit-tested via DI, never against live Supabase/storage; only CAMS CAS has a dedicated fixture.

---

## 3. AIE-1.3 — FDH Bank-Statement Adapter

**Branch:** `feature/aie-1-3-fdh-bank-adapter` (off 1.1), commit `83eb0cd`, pushed.
**Status:** Implemented, tested. Not certified/merged/deployed at the time.

Key discovery: FDH-5's bank-PDF engine (8 certified adapters: AU CBA/ANZ/NAB/Westpac, India SBI/HDFC/ICICI/Axis) already exists — this narrowed the job to "wrap and gate an already-certified pipeline." Confirmed by direct grep that `bank-pdf/ocr.ts` has no real OCR engine wired — scanned/image statements are honestly still unsupported.

**Built:** migration `0142` (renumbered from a caught collision with AIE-1.2, exactly the discipline this required); `lib/aie/adapters/fdhBankStatement/`; 3 flags default OFF; one disclosed additive change to AIE-1.1 core (`orchestrator.ts` gained an optional `parserOverride` field — all 62 existing 1.1 tests still pass unchanged); canonical write delegates to FDH-5's own unmodified upload/process functions. AI scope: only an institution-hint-on-ambiguous-layout is ever AI-eligible — every transaction fact is permanently excluded by construction, proven by a dedicated test.

**Verified:** tsc/eslint clean, 23/23 new tests (one real bug found+fixed: an `ambiguous` vs `unsupported_layout` branch-ordering defect), zero regression (351/351), full suite 6397 passed. **Deferred:** scanned/OCR statements, password-protected retry flow, live-DEV corpus run. (Its implementation report was initially missing entirely — written retroactively during production-cert planning, see §7.)

---

## 4. AIE-1.4 — Other PDF-Enabled Modules

**Branch:** `feature/aie-1-4-other-modules` (off 1.1), commit `90c1ffb`, pushed.
**Status:** Implemented, tested. Not certified/merged/deployed at the time.

9 candidate document classes named by the spec's own discovery section; a 10th (identity/medical/legal/sensitive) is explicitly **prohibited** by the spec itself.

**Eligibility decisions (honest gate, not a shallow multi-class touch):**
- **Insurance — IMPLEMENT NOW.** Real mature RLS-protected table + live write service, reached today only by manual entry, no PDF path — exactly the gap this phase exists to fill.
- Payslip/income, loans/liabilities, retirement/SMSF — **deferred** (each already has its own mature FDH pipeline; wrapping properly is its own multi-session effort).
- Assets/valuation, goals, bills/expenses, tax evidence — **deferred**, each for a named repo-grounded reason.
- Cross-border — N/A as its own class, satisfied via Insurance's existing country/currency gate.
- Identity/medical/legal — **prohibited**.

**Built:** `lib/aie/adapters/insurance/**`, `app/api/aie/insurance/intake/route.ts`, migration `0143` (collision-checked against `main` + both sibling branches); 2 flags default OFF. Canonical write delegates to the same `makeRegistry('insurance_policies').save()` the real manual-entry route uses. Owner field always caller-supplied, never derived from document text.

**Verified:** 42/42 new tests, tsc/eslint clean, full suite 6416 passed. Two real defects found+fixed (a label-matching precedence bug — "Sum Insured" money swallowed into the name bucket; the same `fdh1Isolation.test.ts` false-positive pattern). **Disclosed:** 8 of 9 candidate classes remain unimplemented; no real insurer's exact layout tested; no review UI existed yet at this point (self-accept placeholder only).

---

## 5. AIE-1.5 — Unified Exception-Review UX

**Branch:** `feature/aie-1-5-exception-review-ux` (off 1.1), commit `17fe496`, pushed.
**Status:** Implemented, tested. Not certified/merged/deployed at the time.

**Merged AIE-1.4 (Insurance) in and actually integration-tested against it** — the full real journey (extraction → blocking reconciliation failure → typed correction → revalidation → acceptance → real canonical write) runs against unmodified pipeline code. **Investment Intelligence (1.2) and FDH bank (1.3) remained design-compatible only at this point** — read via `git show`, never merged or executed; explicitly flagged `integrationTested: false`.

**Built:** migration `0144` (3 additive nullable columns, no new table); `lib/aie/review/` (12 files: state mapping, reason-code/module registry, typed correction validation, candidate-merge that never mutates original evidence, dependency-aware revalidation, acceptance gate, rejection, evidence reveal); 6 API routes; frontend at `app/(app)/aie-review/**`.

**Real safety gap caught and fixed before shipping:** `revalidateRun` would have silently fabricated a "nothing blocking" result for adapters this pass cannot actually reconcile (II/FDH) — fixed to structurally refuse instead of ever presenting a false-clean result.

**Verified:** tsc/eslint clean, full suite 6500 passed, identical pre-existing-failure baseline. **A real test-count discrepancy in this phase's own claim was later caught by AIE-1.6** (see §6) — the actual number was 84, not 138. No live-DEV/Supabase verification was performed at this point (queued for later, see §8/§9). No PC5 integration, no bulk actions, no post-acceptance undo, no accessibility tooling.

---

## 6. AIE-1.6 — Independent Interim Certification

**Branch:** `feature/aie-1-6-certification` (off 1.5), commit `b22fc42`, pushed. Report: `AIE_1_6_CERTIFICATION_REPORT.md`.
**Verdict: cannot issue a platform-wide GO/NO-GO — CONDITIONAL PASS for 1.1+Insurance(1.4)+review-UX(1.5) on real re-executed evidence; 1.2/1.3 paper-reviewed only, not runtime-verified; full merged platform not certifiable (no merge existed yet).**

**Real findings, not a status re-statement:**
1. **Test-count discrepancy**: 1.5 claimed 138 tests; independently re-running the exact same command twice gave **84** (10 files) — 1.5's own commit message's per-file breakdown only summed to 85 and was internally inconsistent. Flagged prominently, not corrected quietly. Did not change tsc/eslint/full-suite results.
2. **A real, demonstrated (not theoretical) security gap**: constructed a `/JavaScript` action inside a `FlateDecode`-compressed PDF stream and confirmed it evaded `scanPdfStructure` entirely, passing full admission — proof the disclosed "no real AV" limitation was a real, exploitable bypass of the structural heuristics specifically. Open at the time; **fixed during production-cert planning, see §7.1**.
3. **AIE-1.3 had no implementation report at all** — fixed retroactively, see §7.2.
4. **AIE-1.3's canonical-write path was never migrated onto AIE-1.5's centralized `accept.ts` gate** — a real integration debt, resolved during the real merge (§8, item 2b).
5. Cross-tenant isolation sound on paper but not live-database-proven at this point (no DB access from that sandbox). Kill-switch/rollback only partial — no retention/purge job exists anywhere in AIE yet (still true — see §10).
6. Two adversarial tests it wrote itself (a concurrent-`Promise.all` idempotency probe against `acceptRun()`, and the hostile-PDF probe above) committed as new test files.

**This pass granted no production authority whatsoever** — restated explicitly, matching every prior phase.

---

## 7. Production-Certification Planning

**Branch:** `feature/aie-1-production-cert-plan` (off 1.6), commit `6b2854f`, pushed. Report: `AIE_1_PRODUCTION_CERTIFICATION_PLAN.md`.

Both of AIE-1.6's real findings were **fixed outright** during this planning pass, not just planned around:

1. **PDF-structural-scan bypass fix** — `fix/aie-1-1-pdf-flatedecode-detection` (off 1.1), commit `1afceec`, pushed. `scanPdfStructure()` now decompresses every declared `/FlateDecode` stream (`node:zlib` `inflateSync`, no new dependency) and re-scans the decompressed content, bounded by a stream-count cap (200) and a total-decompressed-bytes cap (20MB, catching zip-bomb-shaped streams too). Still explicitly a heuristic — a different/chained filter could still hide a token, and the module header says so precisely. 7 new tests including a byte-for-byte reproduction of AIE-1.6's own adversarial fixture; 69/69 in the AIE-1.1 suite, zero regression.
2. **AIE-1.3's missing implementation report** — written retroactively, pushed to `feature/aie-1-3-fdh-bank-adapter` itself. Independently re-ran 1.3's own suite (23/23, exactly matching its original claim — no discrepancy this time).

The plan document itself also: scopes live-DEV verification's proof obligations; adds a new real-AI-provider integration test plan (cost ceiling, masking-refusal proof, schema-rejection proof, kill-switch proof — never attempted, since only `MockAieProvider` has ever run); designs a retention/purge job (reusing LR-1's own sweep-cron pattern); names three explicit Product-Owner scope decisions rather than assuming them (PC5 integration, accessibility tooling, malware-scanner risk acceptance); and a staged-rollout design that explicitly **cross-references the G8 discovery finding that no controlled-cohort/percentage-rollout mechanism exists anywhere in this codebase** — AIE would be the first feature to actually need the mechanism G8 has already flagged as a still-open PO decision.

---

## 8. Merge Planning + Real Merge

**Merge planning branch:** `feature/aie-1-merge-plan` (off cert-plan), pushed. Report: `AIE_1_MERGE_PLAN.md`. A real, empirically-validated dry-run merge was performed in a disposable scratch branch (never pushed, deleted after) — all 6 real branches confirmed untouched at their original hashes afterward.

**Dry-run result:** mostly clean, 3 real but harmless conflicts (all at identical append-anchor points across independent phases), all resolved by keeping both in phase order. Merge order: 1.5 → 1.6 → PDF-fix → 1.2 → 1.3 → cert-plan.

**User's decision at this checkpoint**: *"Yes, but also fix the 2 new findings first"* — merge for real, then fix `moduleRegistry.ts` + both `accept.ts` items, then proceed to live-DEV.

**Real merge executed**, branch `integration/aie-1-release-candidate`, matching the dry-run exactly (same order, same 3 conflicts, same resolutions). Re-verification identical to the dry-run: 137 migrations no collision; tsc/eslint clean; 263/264 AIE-scoped (the one "failure" is the correct expected flip — the old adversarial-PDF assertion now correctly fails because the bypass is closed); full suite 310 passed/18 failed/2 skipped matching the known baseline plus that expected flip.

**Follow-up fixes, all completed (not deferred):**
- **2a — `moduleRegistry.ts`**: guessed adapter-id predicates for II/FDH-bank fixed to the real committed ids (`ii_cas_kfintech_folio_v1`, `aie_fdh_bank_statement_bridge_v1`, `aie_fdh_bank_statement_classification_v1`). 4 new tests; 88/88 aieReview tests pass.
- **2b — AIE-1.2 `accept.ts` dispatch**: `accept.ts` was hardcoded to always write through Insurance regardless of source adapter — a real, would-have-shipped bug. Fixed to dispatch on the run's real recorded adapter id. 8 new tests, 138/138 pass.
- **2c — AIE-1.3 FDH-bank commit path**: completed, not deferred. New migration `0145` (one nullable JSONB column on `aie_document_intake`) plus wiring. **A genuine additional finding caught during this fix**: `commitFdhBankStatementImport` had no existing-write check of its own — routing it through `accept.ts`'s retriable flow opened a real crash-window double-import risk, closed with a new idempotency guard reusing the existing `aie_write_batch` row. 8 new tests, 152/152 pass.

**Final verification on the fully merged+fixed branch**: tsc clean, eslint clean, 283/284 AIE-scoped, full suite 310 passed/18 failed/2 skipped — zero new regressions beyond the already-known baseline.

---

## 9. Live-DEV Verification

### Pass 1 — partially blocked on infrastructure, not a code defect

Branch `integration/aie-1-release-candidate`. **Blocker**: this sandbox had no DDL channel against the real DEV Supabase project — confirmed both by a live schema-cache probe (migrations `0140`–`0145` not applied, no `aie_*` table existed yet) and an exhaustive probe of every possible DDL-execution channel. Same category of ask as every prior "please apply migration NNNN" moment in this project's history.

**What was completed live for real**: created the `aie-document-quarantine` Storage bucket; proved the cross-tenant RLS negative-control **method** live end-to-end on an analog real RLS-protected table (2 disposable synthetic DEV users, positive control then blocked cross-tenant read+write, zero residue after cleanup); found and fixed a stale regression test that still asserted the pre-fix vulnerable PDF behavior — 284/284 AIE tests then passing.

**Still blocked pending migration application**: RLS proof on the real `aie_*` tables themselves; the full Insurance end-to-end journey against real infrastructure; the hostile-PDF-against-the-real-route check.

*(Migrations 0140–0145 were subsequently applied to both DEV and production later the same day — see the note at the end of this section. That unblocked Pass 2 below.)*

### Pass 2 — all 3 previously-blocked items completed; one defect fixed, one found and corrected via migration

1. **Cross-tenant RLS on the real AIE tables — 34/34 PASS.** Two real disposable tenants, positive-control-first. `aie_document_intake`: read/update/impersonation-insert all correctly blocked (real `42501`). `aie_unresolved_item`/`aie_review_decision`: read isolation + a blocked write confirmed to leave the row byte-for-byte unchanged. `aie_mask_token_map`: confirmed unreadable by both the owning tenant and an unrelated one (zero policies by design) — a service-role read proved the row genuinely exists, so "denied" is real, not coincidental absence.

2. **Real end-to-end Insurance journey — proved through to a real canonical write, then hit a genuine separate schema defect.**
   - **Defect found and fixed**: `app/api/aie/insurance/intake/route.ts` never actually registered the Insurance parser — a bare import carried a false "side-effecting registration" comment while the imported module has no import-time side effects; every unit test masked this by calling the registration function directly. Fixed with an explicit call + a new regression test (the one test that would have caught it). 393/393 AIE tests pass.
   - Then drove a real PDF through the fixed route: real quarantine upload, 19 real extracted candidates, reconciliation passed, reached `awaiting_acceptance`. Also drove a deliberately-broken fixture → real blocking unresolved item → real correction submitted through the review API → correctly revalidated → the **corrected** value (not the original) reached the attempted write.

3. **Hostile PDF vs. real infrastructure — DONE.** The exact FlateDecode-hidden `/JavaScript` fixture POSTed to the real running `/api/aie/intake` route: rejected `structural_reject`, confirmed via direct DB query it never reached storage.

4. **A second real, significant defect found (not fixable from that sandbox — no DDL path)**: `aie_ii_adapter_link` (0141) and `aie_insurance_adapter_link` (0143) both reuse the shared `aie_assert_child_owner()` trigger (0140), which references the wrong column name (`intake_id` instead of the correct `aie_intake_id` these two tables actually use). Live-reproduced impact: every insert into the link table failed with `42703` — but the actual canonical `insurance_policies` row had already written successfully just before that, so the run was wrongly reported as failed, **and** because the idempotency-tracking link row never got written, a retry created a **second, duplicate** policy row. Confirmed live (a duplicate row was actually produced during testing, then cleaned up).
   - **Fixed by the orchestrating session directly**: verified the exact column-name mismatch independently by reading both migrations' own `CREATE TABLE` statements (not trusting the report blindly), then wrote migration `0146_aie1_adapter_link_trigger_column_fix.sql` (gives both link tables their own correctly-column-named trigger function; the shared core function is left untouched, since it is genuinely correct for AIE-1.1's own child tables). Collision-checked clean against `origin/main` and the separate `feature/g6-g8-country-programme-closure` branch. Committed `e37b2e7`, pushed.

Cleanup for Pass 2: every synthetic user/row/storage object deleted and independently re-verified gone (24/24 checks) plus a final out-of-script sweep.

**Migration application note**: migrations `0140`–`0145` (this programme) were applied to both DEV and production the same day, alongside the concurrent G6-G8 programme's `0138`/`0139` (the user applied all 8 to production first by mistake, then correctly to DEV — independently re-verified in both environments, risk assessed as low since it's purely additive and no deployed production app code references this schema, as `integration/aie-1-release-candidate` isn't merged to `main`). **Migration `0146` (the adapter-link trigger fix) has since been applied to DEV**, per the user's message earlier this session. **Not yet re-verified**: the Insurance journey has not been re-run against DEV since `0146` landed, so genuine `completed` status (rather than the masked-failure/duplicate-write defect) has not yet been re-confirmed live. This is the one concrete open action before AIE-1's live-DEV evidence can be called fully closed.

---

## 10. Outstanding items (honest, as of this report)

- **Re-run the Insurance live-DEV journey** now that `0146` is on DEV, to confirm it reaches genuine `completed` status with no duplicate-write risk. Not yet done this session (this session's time went to the concurrent G5/G6/G7/G8 country-programme thread).
- **`0146` has not yet been applied to production** (only DEV, per the user's message). The same schema-application risk profile as `0140`–`0145` applies (purely additive, no deployed app code references it yet).
- **No production authority has been granted anywhere in this programme.** Every phase document says so explicitly; this report does not change that.
- **Three Product-Owner scope decisions remain open**, named in the production-certification plan, not decided here: PC5 integration scope, accessibility tooling investment, and malware-scanner risk acceptance (the plan recommends allowlist-only + accepted-risk-with-monitoring for an initial small cohort, but defers the actual call).
- **No controlled-cohort/percentage-rollout mechanism exists** for AIE to use when a production rollout is eventually authorized — this is the same gap G8's own discovery named independently; AIE would be the first real consumer of whatever mechanism gets built there.
- **No retention/purge job exists yet** for quarantined documents/masked tokens — designed in the production-cert plan (reusing LR-1's sweep-cron pattern), not built.
- Real-AI-provider integration (cost ceiling, masking-refusal proof, schema-rejection proof, kill-switch proof) has never been exercised — only `MockAieProvider` has ever run.

---

## 11. Final status table

| Phase | Branch | Status |
|---|---|---|
| 1.1 Shared gateway | `feature/aie-1-1-document-gateway` | Implemented, tested, merged into release candidate |
| 1.2 Investment Intelligence adapter | `feature/aie-1-2-investment-adapter` | Implemented, tested, merged; `accept.ts` dispatch bug found+fixed at merge |
| 1.3 FDH bank-statement adapter | `feature/aie-1-3-fdh-bank-adapter` | Implemented, tested, merged; commit path + idempotency guard completed at merge |
| 1.4 Insurance (+ 8 other classes deferred/prohibited) | `feature/aie-1-4-other-modules` | Implemented, tested, merged |
| 1.5 Exception-review UX | `feature/aie-1-5-exception-review-ux` | Implemented, tested, merged; test-count discrepancy disclosed by 1.6 |
| 1.6 Interim certification | `feature/aie-1-6-certification` | CONDITIONAL PASS issued; both real findings fixed in the next phase |
| Merge | `integration/aie-1-release-candidate` | Real merge complete, all follow-up fixes complete, re-verified |
| Live-DEV Pass 1 | same | Partially blocked (no DDL channel), what could run passed |
| Live-DEV Pass 2 | same | All 3 blocked items completed; 1 defect fixed live, 1 defect fixed via migration `0146` (applied to DEV, not yet re-verified, not yet on production) |

**No phase, pass, or this report itself grants production authority.** The next concrete step is re-running the Insurance live-DEV journey against the now-patched DEV schema, then bringing this to the Product Owner for the three named scope decisions and a production-authority ruling.
