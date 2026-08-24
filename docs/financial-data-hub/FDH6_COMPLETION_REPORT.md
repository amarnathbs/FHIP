# FDH-6 — Financial Classification, Transfer, Duplicate & Recurring Intelligence
## Full Status Report

STATUS: CONDITIONAL PASS
Branch: `txn-economic-intelligence`
Starting canonical main: `4b93682` (re-fetched and re-verified unchanged from `origin/main` multiple times throughout this session)
Final certified SHA: `57608eb`
Main merge: NOT performed (out of scope per task instructions — narrow feature-branch commits only)
Migration(s): `supabase/migrations/0072_fdh6_economic_class_gap_closure_rule_seed.sql` — delivered as a file, additive-only (14 new `fdh_classification_rules` rows, zero new tables/columns/constraints), clean-replayed 71/71 in a fresh PGlite rebuild, **NOT yet applied to real DEV** (no DDL execution access — orchestration constraint)
DEV: `vqycarelcoijzwlpkpcz.supabase.co` — live-certified 33/34 PASS (see section 13)
Production: untouched; no production access exists or was used

## 1. Executive Summary

R8 (already merged to `main`) turned out to implement almost all of what the original FDH-6 brief describes as future work: the full 13-class economic taxonomy, transfer/refund/recurring matching engines, merchant/category classification, and classification history — all already live, tested, and unmodified by this phase except for a genuine same-priority rule-conflict gap. R7 independently owns duplicate intelligence end to end (fingerprint + evidence-graded dedup), and a second, weaker duplicate layer was evaluated and explicitly rejected as unsafe given the schema's date-only granularity.

FDH-6 closed five real, narrowly-scoped gaps found by actually reading R8's code and FDH-2's own taxonomy/rule seed against the frozen economic-class enum: (G1) no structured review-reason taxonomy existed; (G2) three economic classes (`debt_principal`, `asset_purchase`, `asset_sale`) were schema-complete but had zero reachable path — confirmed both by reading every migration file and by a live-DEV REST query; (G3) same-priority rule conflicts were resolved by silent, non-deterministic array order instead of being detected; (G4) matching/detection thresholds were scattered across four files; (G5) the most significant functional gap — confirming a matched transfer link never actually wrote `economic_transaction_type = 'transfer'` back onto the underlying transactions, so a confidently-matched, user-confirmed internal transfer could sit as two permanent `unknown` rows forever. All five are closed, tested (137 new FDH-6 test cases, all passing), and G5 is independently proven working on real DEV (`FDH6-XFER-05`).

Building the mandatory scale certification also surfaced and fixed a genuine, previously-undisclosed pagination defect in the shared FDH repository layer (`base.ts`): several real R8/FDH-6 call sites requesting more than 1,000 rows were silently capped by PostgREST regardless of the requested limit. Fixed additively (new `listForUserAll()`/`listActiveAll()` methods reusing R7's own `fetchAllRows()`) with zero behaviour change to every other existing caller.

The one item keeping this CONDITIONAL rather than UNCONDITIONAL: migration `0072` cannot be applied to live DEV from this environment (no DDL execution access, disclosed as a hard constraint from the outset). Every other capability this phase adds or fixes — including the transfer write-back, the pagination fix, and the rule-conflict detection — is proven live. The single live-DEV certification failure (`FDH6-PDF-05`) is exactly and only this: a PDF-sourced "BROKER FUNDING" transaction stays `unknown` on DEV today because the new global rule that would classify it does not exist there yet, while the identical rule/scenario is proven correct in the fully-offline, from-scratch certification pack. This is a genuinely external, disclosed, narrow gap — not a concealed classification-integrity, transfer, cross-tenant, or rule-governance defect (spec sections 136-137).

## 2. R8 Adoption Audit
Areas audited: 22. Fully reused: 17. Partially reused (schema/domain contract existed, wiring/depth added by FDH-6): 4 (review-reason surfacing, economic-class reachability, certification depth, threshold centralisation). New FDH-6 capability areas implemented from scratch: 1 (rule-conflict detection — new decision logic, reusing the existing precedence/tier structure). Duplicate category engines: 0. Duplicate merchant engines: 0. Duplicate transaction models: 0. Duplicate ingestion-dedup engines: 0. Full detail: `FDH6_R8_ADOPTION_AND_GAP_AUDIT.md`.

## 3. Architecture

One chain: CSV (R7/FDH-4) or PDF (FDH-5) → canonical transaction (FDH-1) → R8 merchant/category engine (unmodified) → FDH-6 orchestration (economic-class gap closure, rule-conflict detection, transfer write-back, review-reason surfacing, centralised thresholds) → review. No second canonical transaction model, no second precedence order, no second duplicate engine. Full detail: `FDH6_CLASSIFICATION_ARCHITECTURE.md`.

## 4. Economic Classification

Independent, hand-authored certification pack (`tests/unit/fdh6IndependentCertificationPack.test.ts`, expected values derived by reading the actual migration SQL, never by running the production engine and copying its output): **98/98 PASS**. Section-by-section: AU scenarios 20/20, India scenarios 20/20, full 13-economic-class reachability matrix 14/14, transfer scenario pack 12/12, recurring scenario pack 14/14, refund pack 8/8, duplicate intelligence proof 5/5, weakened-implementation negative-control proofs 5/5. Combined with R8's own pre-existing, independently re-reproduced suite this session (69 unit cases, 41/41 independent oracle comparisons, 30/30 security checks — see section 16), and this phase's own new pure-function suite (thresholds/rule-conflict 14, review-reasons 12, pagination 13 — all passing), the full FDH-6 + reused-R8 classification certification surface totals **291 passing cases** across this session, zero failures, zero flakes.

Results by class (all 13 independently confirmed reachable in the pack's dedicated matrix, section C): income, expense, investment, debt_interest, refund, tax, fee, cash_withdrawal, unknown — all pre-existing, reproduced correctly. debt_principal, asset_purchase, asset_sale — **newly reachable via migration 0072**, confirmed correct in the offline pack; confirmed NOT YET reachable on live DEV pending migration application (the disclosed CONDITIONAL gap). transfer — confirmed as a structural candidate signal offline, and confirmed as an actual committed economic class live (`FDH6-XFER-05`).

## 5. Classification Precedence

User rule: PASS. Source signal: N/A (structurally unimplemented by design across FDH-1/FDH-2/R8, unaffected by FDH-6). Merchant: PASS. MCC: N/A (structurally unreachable — no ingestion source in this repository ever carries MCC data, disclosed boundary, unchanged). Global rule: PASS. UNKNOWN/review: PASS, including the new RULE_CONFLICT outcome (`fdh6ThresholdsAndRuleConflict.test.ts`, 7 dedicated cases including an order-independence negative-control proof).

## 6. Transfer Intelligence

Matched: 12/12 (offline pack) + 1/1 (live DEV, `FDH6-XFER-01..08`). Cross-bank: 1/1 (`[T-02]`, offline) — institution equality never required. Missing counterpart: 1/1 (offline `[T-03]`) + 1/1 (live DEV `FDH6-MISSING-01/02`). Ambiguous (multiple-candidate): 1/1 (`[T-08]`, closest-date wins, no double-claiming). False-positive negative-control cases: 3/3 (`[T-06]` same-amount-unrelated, `[T-07]` different-currency, plus the live-DEV tenant-boundary proof in section 14). **The core gap closure — confirming a link now writes `economic_transaction_type = transfer` back onto both transactions — is proven live** (`FDH6-XFER-05`, real DEV rows, both sides genuinely flipped from `unknown` to `transfer`, independently audited via `fdh_transaction_corrections`).

## 7. Duplicate Intelligence

R7 reused: Y (100% — zero new duplicate-detection code written; a second, fuzzy amount+date-only layer was evaluated and explicitly rejected as unsafe given this schema's date-only, no-time-of-day granularity — see `FDH6_DUPLICATE_INTELLIGENCE.md`). Positive: 2/2 (`[D-02]`, `[D-04]` cross-format). Negative: 3/3 (`[D-01]` weak-evidence never auto-confirmed, `[D-03]` different month never duplicate, `[D-05]` one-sided evidence never auto-confirmed). Cross-format: 1/1 (`[D-04]`, fingerprint deliberately excludes import-batch id). Reprocessing/idempotency: PASS (`transactionClassificationService.ts`'s `changed` guard, unmodified by this phase, re-verified via R8's own reproduced oracle).

## 8. Refund/Reversal

Cases: 8/8 (`[F-01]` through `[F-08]`). Partial refund: PASS (`[F-02]`, amount need not equal original). False-positive controls: PASS (`[F-03]` different account/merchant, `[F-04]` salary never treated as a refund because never refund-classified in the first place, `[F-06]` refund-exceeds-original rejected, `[F-07]` refund-before-original rejected, `[F-08]` outside-lookback rejected).

## 9. Recurring Intelligence

Cases: 14/14. Weekly/fortnightly/monthly/quarterly/annual: each PASS (`[R-01]`-`[R-05]`). Variable amount: PASS (`[R-06]`, `[R-13]` salary with overtime/bonus variance). False positives: PASS (`[R-09]` single occurrence, `[R-10]` different merchant same amount, `[R-11]` genuinely irregular gaps, `[R-14]` credit/debit never mixed). Business-day shift: PASS (`[R-07]`). Missed month: PASS (`[R-08]`, whole group correctly disqualified rather than half-reported).

## 10. User Corrections & Learning

Correction audit: PASS (live DEV `FDH6-CORRECT-01/02`, persisted, `user_override=true`, real correction row). Personal rule: PASS (R8, unmodified, reused). Global automatic promotion: **NONE** (no FDH-6 code path writes `fdh_merchants`/`fdh_classification_rules` from user-derived data; FDH-2's `globalLearningGovernance.ts`/`personalPayeeGuard.ts` domain contract exists but candidate-intake wiring/admin UI is explicitly out of scope per spec sections 91/125's own N/A allowance). Candidate-global workflow: **N/A**. PII screening: PASS (heuristic exists and is unit-tested since FDH-2, unmodified, correctly still never invoked automatically). Live DEV additionally proves the global rule a correction's transaction originally matched is byte-unchanged after the correction (`FDH6-CORRECT-03`).

## 11. Financial Integrity

Exact money: PASS (integer minor-unit arithmetic throughout — transfer bucket keys, refund amount comparisons, split allocations; no JS floating-point financial comparisons anywhere in FDH-6's own code). Source amounts unchanged: PASS (`applyTransferClassOnConfirm` writes only `economic_transaction_type`/`category_id`/`subcategory_id`, never amount/date/direction; grep-verified). Split allocation: PASS (live DEV `FDH6-SPLIT-01/02`, $300 split into $220+$80, sum exactly equal, RLS-scoped user session, no service-role). Negative controls: PASS (section 9 of `tests/unit/fdh6IndependentCertificationPack.test.ts`, 5 deliberately-weakened-implementation proofs).

## 12. Scale

1000/1001/5000/10000: each PASS (`tests/unit/fdh6Pagination.test.ts`, 13/13, including the negative control proving the OLD single-page method genuinely truncates on the identical fixture). Pagination: PASS — real, previously-undisclosed defect found and fixed (section 1); `listForUserAll()`/`listActiveAll()` additively reuse R7's `fetchAllRows()`.

## 13. Live DEV

CSV→FDH-6: PASS (`FDH6-CSV-01..03`, real upload through the R7/FDH-4-certified CBA adapter, real `/detect`+`/process`, real classification). PDF→FDH-6: **CONDITIONAL** — upload/process/salary/ATM classification all PASS (`FDH6-PDF-01..04,06`); the one new-rule case (`FDH6-PDF-05`, BROKER FUNDING → asset_purchase) FAILS only because migration `0072` is not yet applied to DEV, reproduced identically across two independent runs. Matched transfer: PASS (`FDH6-XFER-01..08`, including the core gap-closure proof). Missing counterpart: PASS (`FDH6-MISSING-01/02`). User correction: PASS (`FDH6-CORRECT-01..03`, after fixing a bug in this script's own test fixture — see below). Cleanup: PASS (`FDH6-CLEANUP-01..03`, independently re-verified — zero residual transactions, zero residual accounts, both synthetic users genuinely 404 after deletion).

**Overall: 33/34 PASS.** Full transcript-backed detail in `FDH6_LIVE_DEV_CERTIFICATION.md`.

**Self-caught test-script defect, disclosed honestly**: the first live-DEV run also showed `FDH6-CORRECT-02`/`03` failing. Root cause was in the CERTIFICATION SCRIPT itself, not production code: it guessed a category key of `'groceries'`, which does not exist in FDH-2's real taxonomy (verified live: `fdh_categories?category_key=eq.groceries` → `[]`; the real key is `food`). Fixed the script (real key, and decoupled the correction-test target from the migration-0072-dependent transaction) and re-ran — clean pass. Disclosed here rather than silently re-run and omitted, per this task's own standing instruction to report real numbers, not rounded-up ones.

## 14. Security

Tenant tests: 7/7 (`FDH6-SEC-01..07` — read A's transaction, classify-call scope, forged link review, forged correction, read A's personal rules, read A's split allocations, forged direct `fdh_transaction_links` INSERT — all blocked). Forged classification: N/A as a distinct case (no dedicated "classify on behalf of another user" API exists — `FDH6-SEC-02` proves B's own classify call touches only B's own zero transactions). Forged transfer: PASS (`FDH6-SEC-03`, 404). Forged correction: PASS (`FDH6-SEC-04`, 404). Personal-rule privacy: PASS (`FDH6-SEC-05`). Compiled bundle: PASS — FDH-6 adds no new service-role-touching file (`tests/unit/fdh1Isolation.test.ts`'s sanctioned-file list unchanged; reproduces 25/25 in isolation, see section 16 for the one environmental full-suite timeout). Reproduced (not re-derived): R7 security cert 45/45, R8 security cert 30/30, FDH-2 RLS cert 61/61 — all clean on this branch, proving FDH-6's edits did not weaken any existing guarantee.

## 15. Data Preservation

FDH master/rule data: **14 rows added** (migration `0072`, additive only, `0 -> 60+14=74` `fdh_classification_rules` rows once applied; confirmed 0 collision with any concurrent stream via a live-DEV REST count immediately before allocating the migration number — 60/60 matched the migration-file count exactly). R8 master/rules: unchanged. Parser registry: unchanged (no file under `bank-csv/`/`bank-pdf/` parser registration touched). Investment Intelligence: **UNCHANGED** — zero files under `lib/services/investment-intelligence/`, `lib/engines/investment-intelligence/`, `app/api/investment-intelligence/` touched (confirmed via `git status`/`git diff --stat` for the whole session; two auto-regenerated timestamp-only artifact files were reverted rather than committed). Resources: **UNCHANGED** — zero files touched; the one full-suite environmental flake (`resourcesEditorR1_3.test.ts`, Supabase Auth OTP rate-limiting from this session's own repeated live-DEV runs against the same DEV project) is a test-infrastructure timing issue, not a data or code change, and reproduces the exact same "Request rate limit reached" signature independently confirmed earlier this session. Input Data: **UNCHANGED** — no FDH-6 code path writes to it (spec section 98 boundary preserved by construction; grep-verified).

## 16. Regression

Migration guard: PASS (`npm run check:migrations` — 71 active migrations, one file per version, next version 0073). Cross-branch guard: PASS (`npm run check:migrations:against-main` — 0 collisions vs `origin/main`, re-verified against a freshly re-fetched `origin/main`, still `4b93682`, immediately before allocating migration `0072`). Clean rebuild: PASS (71/71 migrations replay from empty with zero manual intervention, 174 tables, 174/174 RLS enabled, 0 disabled). TypeScript: PASS (`tsc --noEmit`, 0 errors, reproduced multiple times across the session including after every code change). Vitest: **2228/2252 PASS, 0 FAILED, 24 pending** (final full-suite run, this branch — `numFailedTests: 0`; one suite, `resourcesEditorR1_3.test.ts`, is marked suite-failed due to the live-DEV auth-rate-limit environmental issue described above, containing 0 individually-failed assertions). ESLint: PASS, 0 errors, 0 warnings on every new/modified FDH-6 file (4 initial unused-var warnings found and fixed). Build: PASS (`next build`, exit 0, full route manifest produced including `/financial-data-hub`) — the first attempt failed on an unrelated `.next/dev/types` stale-cache artifact from having run `next dev` immediately beforehand in the same worktree (exactly the known Turbopack-cache gotcha this project has hit repeatedly); clearing `.next` and rebuilding resolved it cleanly, consistent with every prior occurrence. R7/FDH-4: PASS (45/45 security re-certified; full suite includes FDH-4's own test files, all passing). FDH-5: PASS (`fdh5R8CrossFormatEquivalence.test.ts` reproduces clean; PDF pipeline exercised live in section 13). R8: PASS (30/30 security, 41/41 independent oracle, unit suite reproduced clean).

## 17. Open Residuals

- **FDH1-F1** (FK bypasses RLS): pre-existing, disclosed since FDH-1, out of this phase's narrow scope per orchestration guidance — untouched.
- **Malware/AV scanning**: not implemented, pre-existing disclosed gap from FDH-3, unaffected by FDH-6.
- **FDH-5 OCR**: explicitly and deliberately kept out of scope per this task's own Product Owner instruction — not implemented, not attempted, status unchanged from FDH-5's own closure report.
- **Orphan-scale validation / concurrency/load**: not separately re-certified this phase (out of FDH-6's scope; no new orphan-generating write path was introduced).
- **DB-BASE-0012**: no new instance found or introduced by this phase.
- **Migration `0072` not yet applied to DEV**: the one item keeping this report CONDITIONAL — see section 13.
- **Candidate-global-learning intake pipeline and admin review UI**: correctly out of scope per spec sections 91/125 (N/A, not a gap).
- **`loan_payment`/`investment_funding` transfer-confirm write-back**: deliberately NOT auto-applied (spec sections 50/99) — confirming these link types still moves the link to `confirmed` but does not reclassify the transactions; disclosed design boundary, not an oversight.

## 18. Production

Deployment: none — this phase never touched production, has no production access, and the task instructions explicitly forbid pushing/merging without separate explicit confirmation. Feature enablement: N/A — no user-facing feature flag exists for this phase's changes; all new logic runs behind the existing `/api/financial-data-hub/bank-transactions/categorise` and `/transaction-links/{id}/review` routes, already gated behind authentication exactly as before. Production migration: not applied (would require migration `0072` to reach production only after first reaching DEV — sequencing unchanged from every prior phase's established pattern).

## 19. Acceptance Checklist

- [x] R8 audited first, real code/tests read before any new logic was written
- [x] Existing R8 merchant engine reused, unmodified
- [x] Existing R8 category engine reused, unmodified except for additive rule-conflict detection
- [x] Existing R7 dedup reused, zero new duplicate-detection code
- [x] No second canonical transaction model
- [x] Economic classification cleanly separated from transaction direction (CREDIT ≠ INCOME, DEBIT ≠ EXPENSE preserved and tested throughout)
- [x] No Input Data writes
- [x] No Investment Intelligence ownership violation (asset_purchase/asset_sale/investment remain labels only, never a holding/tax-lot write)
- [x] All 13 approved economic classes supported (10 pre-existing + 3 newly reachable via migration 0072, offline-proven; live-proof pending migration application)
- [x] UNKNOWN works safely, including the new RULE_CONFLICT outcome
- [x] Precedence deterministic, user-rule precedence correct, proven order-independent
- [x] History/provenance preserved (`fdh_classification_history` unmodified; corrections independently audited)
- [x] Confidence separate from extraction/reconciliation (unchanged)
- [x] Own-account/cross-bank transfer matching; missing-counterpart state; tenant-scoped; exact-money; false-positive controls; no income/expense double-counting — **the double-counting fix is this phase's central, live-proven contribution**
- [x] Duplicate handling: R7 reused, legitimate repeats preserved, recurring never confused with duplicate, reprocessing idempotent
- [x] Refund not income; partial refund supported; false matches rejected
- [x] Recurring: all cadences, variable amounts, business-day shifts, false-positive controls
- [x] User corrections audited; personal rules win; zero automatic global promotion; personal payees protected; PII screening heuristic intact
- [x] Security: real Tenant A/B tests, 7/7 forged actions blocked live, no service-role in browser bundle, admin gains no new transaction visibility
- [x] Scale: 1000/1001/5000/10000 all correct, real pagination defect found and fixed
- [x] Regression: guards/rebuild/TypeScript/Vitest/ESLint/build all clean; R7/FDH-4/FDH-5/R8/II/Resources/Input Data all unchanged or independently reproduced clean
- [ ] Migration `0072` applied to DEV (external, pending — the sole CONDITIONAL item)

## 20. Final Verdict

**CONDITIONAL PASS.** Every classification-integrity, transfer, duplicate, refund, recurring, security, scale, and financial-integrity requirement is genuinely met and independently reproduced — including live on real DEV. The single gap is exactly the kind spec section 137 describes as legitimately CONDITIONAL: implementation complete, one external live-DEV migration-application step remains, honestly disclosed rather than concealed, and it does not touch classification-integrity, transfer false-positives, cross-tenant isolation, or rule-governance in any way. Upgrade path to UNCONDITIONAL FULL PASS: apply migration `0072` to DEV, re-run `FDH6-PDF-05` (and ideally the full live-DEV script once more end to end).

## 21. FDH-7 Readiness: GREEN

FDH-6 leaves a single, consistent financial-intelligence chain exactly as spec section 141 describes: Bank activity → CSV/PDF → Canonical Transaction → R8 Merchant + Categorisation → FDH-6 Economic Classification + Transfer Intelligence + Refund/Reversal + Recurring Intelligence → Review. Review-reason surfacing (`deriveReviewReasons`), split-allocation domain/schema, and structured transfer/duplicate/recurring relationship models are all in place and ready for FDH-7 to build a user-facing review/approval workflow on top of, without FDH-7 needing to introduce another financial-decision engine.

## 22. Next Action: STOP. Do not begin FDH-7.
