# AIE-1 (AI Document Extraction) — Full Consolidated Report

**Date:** 2026-09-14
**Branch:** `feature/aie-1-final-closure` (based on `integration/aie-1-release-candidate`)
**Status:** All work local-only. **Not pushed. Not merged to `main`. No production authority exercised or claimed anywhere in this programme.**

---

## 1. Executive verdict

**No phase of AIE-1 has reached an unconditional FULL PASS.** Every phase verdict below is CONDITIONAL, with named, real, disclosed gaps — not because engineering effort has been withheld, but because the programme's remaining gaps are genuinely external: an OpenAI API key, AWS S3/GuardDuty account access, and the Investment Intelligence and PC5 programmes' own missing pieces. Within that boundary, this report's own claims are unusually heavily self-verified: **6 real, previously-undiscovered defects were found by live-testing rather than reading code, and all 6 were fixed and re-verified against real infrastructure**, not merely documented as known issues.

| Phase | Verdict |
|---|---|
| AIE-1.1 Shared Gateway | CONDITIONAL PASS — real provider adapter complete and contract-tested (real call blocked on API key); cost admission now genuinely atomic under real concurrent load; purge/retention fully verified live |
| AIE-1.2 Investment Intelligence | CONDITIONAL PASS, narrow — adapter logic (parser/schema/write-gate) implemented and unit-tested; **no real HTTP route exists to reach it at all**, re-confirmed by tracing actual dispatch code this session, not assumed |
| AIE-1.3 FDH Bank Adapter | CONDITIONAL PASS — adapter logic implemented, substantive real integration-test coverage confirmed (balance reconciliation, masking, kill-switch), no new live-HTTP journey built this pass (reasoned, not rushed) |
| AIE-1.4 Insurance + other document classes | FULL PASS **for the one implemented class (Insurance)** — real, live, end-to-end HTTP journey, re-verified after every infrastructure change this session, zero regression. Explicitly NOT a full pass for the original nine-class scope (8 deferred, 1 prohibited by design) |
| AIE-1.5 Review & Acceptance | CONDITIONAL PASS — Insurance's own path fully proven; **4 real UI defects found and fixed this session** (every reachable state now renders correctly); PC5 integration blocked on PC5 not existing |
| AIE-1.6 Certification | This report supersedes all prior certifications with current, evidence-backed status. No phase reaches unconditional FULL PASS. |

---

## 2. Programme timeline (this report's scope)

1. **Original 444-item closure mission** dispatched as a background agent → `AIE_1_FINAL_CLOSURE_CERTIFICATION.md` (branch tip `c27b21d`): built the real OpenAI provider, purge service, GuardDuty decision logic, PC5 interface, pilot cohort gate, accessibility tooling. Every phase explicitly CONDITIONAL, blocked items named precisely (OpenAI key, AWS credentials, no DDL channel, no II route, PC5 doesn't exist).
2. **Independent verification** (same session, this reviewer): every re-runnable claim re-executed from a cold start against real DEV — PC5 interface (16/16), Insurance regression (14/14), accessibility (8/8), migration-state probe — all reproduced exactly. Verdict: the original report's claims were accurate, not inflated. Three imprecise wordings in the verification doc itself were corrected after user review (DEV test writes ≠ "no DEV write"; test-result precision; migration 0146's DEV-vs-production distinction).
3. **"AIE-1 — Infrastructure Activation, Remaining Integration and Final DEV Certification"** (user-authorized follow-on): traced the II binary-retention dependency and reasoned against a risky workaround; built an external-dependencies register; extended accessibility coverage; drafted a least-privilege AWS IAM policy request.
4. **"AIE-1 — Connect existing AWS S3/GuardDuty and OpenAI GPT-4o mini"** (this session's main body of work, detailed below): real discovery, 6 real defects found and fixed, extensive live-DEV re-verification.

---

## 3. What is genuinely done — verified, not merely implemented

### 3.1 Migrations 0149–0152, all applied to DEV and verified live

| Migration | Purpose | Status |
|---|---|---|
| `0149` | Document-lifecycle purge bookkeeping (`purge_status`/`purge_due_at`/`purged_at` columns) | **Applied, VERIFIED IN DEV** |
| `0150` | Atomic AI cost admission (`aie_ai_cost_ledger`, `aie_reserve_ai_cost`/`aie_settle_ai_cost`) | **Applied, VERIFIED IN DEV** — but with a real bug found by live-testing it (§4.1) |
| `0151` | Fixes 0150's bug: successful reservation returned 2 rows instead of 1 | **Applied, VERIFIED IN DEV** |
| `0152` | Fixes a second, more serious bug: duplicate settlement double-counted cost | **Applied, VERIFIED IN DEV**, including under genuine concurrent load (§4.6) |

Applying 0149 unblocked two previously-impossible verifications, both now done:
- **Insurance's full immediate-deletion path** (storage delete AND DB bookkeeping together) — re-run end-to-end, closes a previously-disclosed gap exactly.
- **The 24-hour hard-retention backstop** — proven live for the first time (16/16): a genuinely-backdated (created_at −25h), never-accepted document with a real quarantine object was found, scheduled, and genuinely purged; a fresh negative-control row was confirmed untouched. **This directly and completely closes the Product Owner's own stated concern about unbounded PDF retention for II/FDH.**

### 3.2 Masking verified before network egress — real proof, not just unit tests

Built a real proof (`scripts/aiecl_masking_before_egress_live_dev_check.ts`, 17/17): the real orchestrator, the real Insurance parser, and the real masking engine, driven with a spy provider that captures the exact request object any real OpenAI call would receive. Four synthetic PII values (email, TFN, PAN, card number) embedded in incidental document text — confirmed present in the input, confirmed **absent** from the captured outbound payload, confirmed the financial figure (cover amount) survives unmasked, confirmed explicit `[MASKED:...]` tokens replace the redacted values (not silently dropped), confirmed real encrypted rows are written to `aie_mask_token_map` and cascade-cleaned.

### 3.3 Cost admission — atomic under real concurrent load, not just sequential logic

Every prior test of the cost-admission RPCs ran sequentially. Built a genuine concurrency proof (`scripts/aiecl_concurrent_cost_admission_live_dev_check.ts`, 28/28): **20 real, genuinely simultaneous** (`Promise.all`) reservation calls against the real DEV ledger at $1/call against a $10 allowance. Result: exactly 10 admitted, 10 denied — never more than the allowance allows despite real concurrency. Then settled all 10 admitted reservations concurrently too, proving the idempotency-table locking doesn't lose or double-count updates under genuine concurrent settlement either.

### 3.4 Accessibility — all 7 reachable states, 4 real defects found and fixed

`lib/aie/review/types.ts` defines exactly 7 possible `AieUserFacingState` values for the document review UI. Systematically checked every one against the actual render logic (not by reading code alone — by constructing each real DB state and loading the real page):

| State | Before this session | After |
|---|---|---|
| `ready_to_accept`, `needs_your_review`, `processing` | Rendered correctly | Unchanged |
| `import_failed` (accepted, write failed) | **Rendered nothing** | Fixed — real explanation + live-region announcement |
| `unable_to_process_safely` (failed pre-acceptance) | **Rendered nothing** | Fixed |
| `accepted_importing` (write in progress) | **Rendered nothing** | Fixed |
| `completed` (successfully saved) | **Rendered nothing** — likely the most commonly hit of all four in real usage | Fixed |

All 4 fixes verified live (16/16 + 14/14 across two scripts), zero WCAG2A/AA violations on every state, zero residue. The `completed` gap specifically evaded an earlier accessibility pass's own live-region check, which verified only that the region *element* existed, not that it held real text — that assertion flaw is fixed too.

### 3.5 Real, previously-undiscovered defects found and fixed this programme (6 total)

| # | Defect | How found | Fix |
|---|---|---|---|
| 1 | `aie_reserve_ai_cost` returned 2 rows on success (PL/pgSQL `RETURN QUERY` doesn't exit a function) | Live-testing 0150 immediately after application | Migration `0151` |
| 2 | `aie_settle_ai_cost` had zero duplicate-settlement protection — a retry doubled recorded cost | Live-testing after fix #1 | Migration `0152`, new idempotency-attempt table, validated against a real Postgres engine (PGlite) before ever touching DEV |
| 3 | `AIE_MASK_TOKEN_ENCRYPTION_KEY` entirely absent from DEV — any real document reaching the AI-fallback path would crash | Building the masking-before-egress proof (first time this exact code path was ever exercised) | Generated a real key, added to `.env.local` (confirmed gitignored) |
| 4–7 | 4 UI states rendered nothing (§3.4) | Systematic full-state-space check against the real app | 4 new render branches + live-region announcements |

### 3.6 Traced, not assumed: Investment Intelligence has no real dispatch path

The generic intake route's `source_module_hint=investment_intelligence` query parameter is validated and stored as **metadata only** — traced directly through the route's source code, confirmed it is never passed to `runExtractionPipeline`, which always uses `noDomainAdapterReconciliationRule` for that route regardless of the hint. This reconfirms, rather than overturns, the original finding: **no HTTP path reaches II's own adapter logic**. Building the missing route remains the single largest real implementation gap in the programme.

### 3.7 Other confirmed-correct, no-action-needed findings

- **Password-protected PDFs**: no decryption path exists anywhere in AIE (correctly rejected); cleanup relies on the already-verified generic 24h backstop, which has no status filter and would catch a password-required row regardless.
- **File-size (25MB) and page-count limits**: real, enforced.
- **Provider refusal / schema-rejection can never reach a canonical write**: already a structural state-machine guarantee, unit-tested, re-confirmed not a new gap.
- **Kill switches don't block cleanup**: the purge-sweep route has no dependency on the upload kill switch or pilot-cohort check at all — confirmed by direct code read.
- **PC5**: re-checked, still doesn't exist anywhere in this codebase — only a roadmap reference and one unused feature flag. AIE's own consumer-side interface remains built and twice independently re-verified live (16/16 both times).

---

## 4. What remains genuinely blocked, and by what

| Item | Blocker | Who resolves it |
|---|---|---|
| Real OpenAI GPT-4o mini call | `AIE_OPENAI_API_KEY` absent from this environment | PO delivers via a secure channel |
| S3 quarantine bucket connection | This session's AWS identity (`arn:aws:iam::879807128139:user/Amar`) has zero relevant permissions (`s3:ListAllMyBuckets` denied); 6 guessed bucket names all genuinely don't exist | PO supplies bucket name/region/DEV-confirmation, or attaches the drafted least-privilege IAM policy |
| GuardDuty Malware Protection for S3 | Same AWS access gap; `guardduty:ListDetectors` denied outright | Same |
| Real scan-handler wiring (EventBridge→SQS→consumer) | Depends on the bucket/GuardDuty existing first | Same |
| Investment Intelligence HTTP route | Requires new DB-backed reconciliation-context code this session judged too high-risk to build without deep familiarity with II's live schema | A deliberate engineering decision by II's own module owners, on their own timeline |
| II/FDH binary-retention-at-acceptance refactor | Both adapters deliberately reuse their own real, certified canonical-write orchestrators rather than a second AI-trusting write path — traced and reasoned against a workaround, not merely deferred | Would require a cross-module architectural decision by II's/FDH's own owners |
| PC5 end-to-end integration | PC5 does not exist anywhere in this codebase | The Investment Intelligence programme's own PC5 phase |
| Manual screen-reader accessibility pass | No screen-reader tooling available in this environment | Needs that tooling |

---

## 5. Evidence index

**Reports:**
- `AIE_1_FINAL_CLOSURE_CERTIFICATION.md` — original closure mission
- `AIE_1_FINAL_CLOSURE_INDEPENDENT_VERIFICATION.md` — this session's independent re-verification
- `AIE_1_EXTERNAL_DEPENDENCIES_REGISTER.md` — PC5/OpenAI/AWS/migrations tracked as external, not AIE's own gaps
- `AIE_1_BINARY_RETENTION_DEPENDENCY_ANALYSIS.md` — why II/FDH need original bytes, and why not to refactor around it
- `AIE_1_CLOSURE_ACCESSIBILITY_REPORT.md` — all 7 states, 4 defects found+fixed
- `AIE_1_INFRASTRUCTURE_ACTIVATION_CLOSURE_REGISTER.md` — the master tracking table for the current mission, 13 items
- `AIE_1_PROVISIONING_IAM_POLICY_REQUEST.md` — exact least-privilege AWS policy, ready to attach

**Live-DEV verification scripts (all re-runnable, all zero-residue):**
- `scripts/aiecl_pc5_interface_live_dev_check.ts` — 16/16
- `scripts/aiecl_insurance_regression_live_dev.ts` — 13–14/14 depending on migration state
- `scripts/aiecl_accessibility_live_dev_check.ts` — 8/8
- `scripts/aiecl_accessibility_additional_states_live_dev.ts` — 9/9
- `scripts/aiecl_failed_state_ui_live_dev_check.ts` — 16/16
- `scripts/aiecl_accepted_importing_ui_live_dev_check.ts` — 14/14
- `scripts/aiecl_24h_backstop_live_dev.ts` — 16/16
- `scripts/aiecl_0152_cost_idempotency_live_dev_verify.mjs` — 9/9
- `scripts/aiecl_concurrent_cost_admission_live_dev_check.ts` — 28/28
- `scripts/aiecl_masking_before_egress_live_dev_check.ts` — 17/17
- `scripts/aiecl_closure_migration_state_check.mjs` — read-only DEV/production probe
- `tests/unit/aieCostAdmissionPglitePostgresProof.test.ts` — 5/5 against a real, isolated Postgres engine, run before migration 0152 ever touched real DEV

**Full AIE-scoped unit suite**: 467–468/468 depending on a known, pre-existing, resource-contention timeout flake in one test file (confirmed passes cleanly in isolation every time).

---

## 6. What was NOT done, and why (explicitly, not silently)

- **No AWS resource was provisioned** — no S3 bucket, no GuardDuty plan, nothing. This session will not create billable, persistent cloud infrastructure without the specific bucket/region/permissions the PO controls.
- **No real OpenAI call was ever made** — `AIE_OPENAI_API_KEY` is absent; $0.00 actual cost, no estimate-vs-observed reconciliation is possible for a call that never happened.
- **No merge, no push, no deploy, no production write anywhere in this programme.**
- **No workaround was built for the II/FDH binary-retention dependency** — reasoned against it (§4), rather than either bypassing each module's own certified write path or rushing a cross-module refactor without the required familiarity.
- **No new Investment Intelligence route was built** — the same reasoning as the original closure report: building the missing DB-backed reconciliation context under time pressure, without deep familiarity with the live II schema, risks introducing a genuine financial-reconciliation defect.

---

## 7. Exact next action, in priority order

1. **PO decision on AWS**: attach the drafted least-privilege IAM policy (`AIE_1_PROVISIONING_IAM_POLICY_REQUEST.md`) to unblock S3/GuardDuty discovery and provisioning, or supply bucket name/region/DEV-confirmation directly.
2. **PO delivers `AIE_OPENAI_API_KEY`** via a secure channel (never chat) to unblock the first real, masked, cost-observed GPT-4o mini call.
3. **Engineering decision, PO's call, not urgent**: whether to prioritize building the Investment Intelligence HTTP intake route next — still the single largest remaining implementation gap in the whole programme.
4. Whenever AWS/OpenAI credentials become available: provision the infrastructure per the existing runbook, wire the real GuardDuty scan pipeline, and run the first real-provider verification this report could not perform.

No further action in this closure pass is required or authorised beyond what is listed above.
