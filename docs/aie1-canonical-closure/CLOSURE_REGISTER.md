# AIE-1 + Approved Upload -> Canonical Data -- Final Production Closure Register

Dispatch: PO "FINAL PRODUCTION CLOSURE MISSION", baseline date 28 September 2026.
This document is the single traceable register required by mission section 3.
It is a **living, incomplete register** -- see "Session status" at the bottom for
exactly what this pass covered vs. left untouched. Do not read any unmarked row
as closed; every row states its own verdict using the mission's PASS /
CONDITIONAL PASS / FAIL / BLOCKED / NOT STARTED vocabulary.

## 0. Baseline reconciliation (mission section 2)

The mission's reported baseline (`main` @ `7edf4a9`, Amplify build 248) is
**stale**. Independently verified this session:

- `origin/main` HEAD is actually **`62b0120296a556a66d5207d8ec7225d65ef791d1`**
  ("docs(canonical-cert): PO decision on the Score/Twin fixture asymmetry --
  accepted as designed, no product fix"), which is **newer** than the reported
  commit -- it includes the PO's own 2026-09-28 Score/Twin decision (mission
  section 8) and the full canonical-cert Stage 3 consolidation history.
- `docs/financial-data-hub/FINAL_COMPLETION_REPORT.md` **is on `origin/main`**
  at that path (confirmed via `git show origin/main:...`); it is NOT only a
  local/scratch file. Its own "Count:" line already reconciles to
  PASS 21 + PASS-with-disclosure 7 + FAIL 1 + NOT RUN 1 = **30**, matching the
  30-row table (R1-R30). The "21+7+1=29, not 30" inconsistency the mission
  flagged was real in an EARLIER summary line of that same report but is
  already fixed in the current `main` HEAD version -- reconciled here, not
  re-broken.
- Migrations 0207-0214 and 0218 (the reported production baseline) are present
  in `supabase/migrations/` on `origin/main`. **Independently confirmed on DEV**
  (`vqycarelcoijzwlpkpcz`, read-only PostgREST OpenAPI introspection with the
  service-role key, this session): `fhip_import_proposals.source_window_from`/
  `source_window_to` (0214-only columns) and
  `fdh_liability_statement_activities.bank_match_candidate_ids` (0208-only
  column) both exist on DEV. This corroborates the report's own claim that
  0207-0214 are live on DEV; it does **not** independently re-confirm 0218 on
  DEV this session (the 2026-09-27 report states 0218 was NOT yet applied to
  DEV at that time -- not re-checked live this pass; see open item OPS-1).
- `supabase/migrations/0202` is confirmed **absent** from `origin/main` and
  from every remote branch's migration directory (repository-wide scan) --
  correctly never applied, consistent with the standing instruction that it
  must never be.
- Migrations 0219-0223 (NAV1) are present on `origin/main`, out of scope for
  this mission per the PO's own instruction; not inspected further here.
- **Production deployed SHA/build identity**: NOT independently confirmed this
  session (no Amplify console/API access in this environment -- the same
  operator-access blocker recorded in prior sessions, e.g. the G8 closure
  pass). BLOCKED, not claimed.

## 1. Requirement register: R1-R30 (Approved Upload -> Canonical Data)

Source: `docs/financial-data-hub/FINAL_COMPLETION_REPORT.md` @ `origin/main`
`62b0120` (the report itself, its four companion certification documents, and
the Stage 3 FINAL live-proof pass it describes). Evidence for R1-R19 and
R21-R29 is **REUSED** from that report per mission section 3 ("reuse valid
evidence; repeat verification only where changes invalidate it or a final
release gate requires it") -- none of this session's changes touch those
rows' code paths. R20 and R26 are called out specifically because this
session acted on them.

| ID | Requirement (brief) | Current implementation | Evidence | Remaining work | Acceptance criterion | Final result |
|----|---|---|---|---|---|---|
| R1 | Every approved fact -> exactly one of A-E disposition; 0 silently dropped | Field-disposition registry, `STRICT_CERTIFICATION` on | Reused: registry 893 entries, gate 36/36, anti-vacuity proven | None identified | 0 open gaps in all 9 disposition files | **PASS** (reused evidence, not re-run this session) |
| R2 | One fact -> one canonical economic effect | Economic-oracle test suite (card/loan/payslip/super/broker/rollover) | Reused: golden-pair $0 unexplained | None identified | No duplicate canonical truth for any oracle scenario | **PASS** (reused) |
| R3 | Payslip field disposition + income de-dup | `scenario_payslip.ts` both orders; `scenario_retirement.ts` | Reused | D-07 (split-deposit/bonus-month duplicate-income prompt) unresolved -- see item D-07 below | Every field disposed; no double income event | **PASS-with-disclosure** (reused; D-07 open) |
| R4 | Bank txn types have a canonical destination | Registry R9 + rule 10 (refund) | Reused | None identified | Every economic type maps | **PASS** (reused) |
| R5 | Planned vs actual expense separation | `CANONICAL_EXPENSE_DATA_CONTRACT.md`; SUI U1 | Reused | "Combined basis" group-displacement PO decision open (see item below) | One read model, each consumer picks its basis | **PASS-with-disclosure** (reused; open PO decision) |
| R6 | Credit-card purchase/repayment/cash-advance/balance | Economic oracle (both filing choices + concurrency) | Reused: 13/13 on the final merged tree | None identified this session (see also mission section 7, NOT independently re-verified this pass) | Never double-counts 220 as both 200 purchase and 440 repayment | **PASS** (reused) |
| R7 | Loan principal/interest/fee decomposition | `scenario_loan.ts` | Reused | Unsplit loan PAYMENT recorded as transfer -- open PO decision | 2,000 = 1,550 + 430 + 20, outflow once | **PASS-with-disclosure** (reused) |
| R8 | Liability Apply atomic, idempotent | True two-connection concurrency test | Reused | None identified | Repeat Apply creates nothing | **PASS** (reused) |
| R9 | AU investments -> Investment Intelligence | `scenario_broker.ts`; live end-to-end upload->Apply->Add to Net Worth | Reused, live-proven in Stage 3 FINAL pass | None identified | Holdings visible, BUY/SELL/dividend correct | **PASS** (reused) |
| R10 | India documents -> India II engine (no shadow engine) | Unchanged by this programme (WP-12 design) | Reused, NOT re-exercised live in Stage 3 | Not re-verified live in this or the prior pass | No second India parser | **PASS-with-disclosure** (reused, stale re-verification) |
| R11 | Retirement summary/evidence/rollover-neutral/SMSF-owned | `scenario_retirement.ts`; SUI U4/5 | Reused | None identified | Super contribution is one effect; SMSF stays SMSF | **PASS** (reused) |
| R12 | Insurance/other uploads included only if a real flow reaches Apply | Field registry: 21 insurance entries `not_active` | Reused | Insurance remains explicitly out of certified scope (mission section 6's "where in approved scope") | No uncertified flow silently activated | **PASS** (reused; scope explicitly narrow) |
| R13 | Input tabs show manual+imported rows with provenance label | SUI U1-U5 screenshots | Reused | None identified | Provenance badge + history link present | **PASS** (reused) |
| R14 | One read model per financial meaning, shared by every consumer | Golden pair: Dashboard/Score/DNA/Resilience/Twin/Forecast/Report agree | Reused | None identified | M == I across every consumer | **PASS** (reused) |
| R15 | Before Apply effect 0; after Apply immediate | GP-1/GP-2 | Reused | None identified | No latent/delayed effect | **PASS** (reused) |
| R16 | Error/null != 0 | DB-1 fix (unreadable sections never scored as 0) | Reused | GAP-09 (null net pay no longer falls back to gross) -- open PO decision | Error state never silently becomes a genuine zero | **PASS-with-disclosure** (reused) |
| R17 | Currency preserved; AUD/INR never summed | GP-6; SR-03 fix (bank-balance asset currency, in 0218) | Reused | 0218 not yet independently re-confirmed live on DEV this session (OPS-1) | No cross-currency addition anywhere | **PASS** (reused; underlying fix's DEV application status is OPS-1) |
| R18 | Self != spouse | GP-7 | Reused | None identified | Household member separation holds | **PASS** (reused) |
| R19 | Cross-tenant == 0 | 12 cross-tenant RPC refusals; SR-02 fix (in 0218) | Reused | Same OPS-1 dependency as R17 | 0 cross-tenant reads/writes | **PASS-with-disclosure** (reused; 0218 DEV-application status open) |
| **R20** | **System-owned provenance unforgeable** | **See detailed sub-rows below** | **Migration 0224 APPLIED to DEV and production (by the PO) and independently LIVE-EXPLOIT-PROVEN BLOCKED on both environments this session, via disposable synthetic accounts (not service-role bypass) -- see R20 detail below** | Close the still-disclosed residuals (SPD-07/SPD-08 sub-limits) | Every provenance-bearing write is either system-derived or explicitly, verifiably manual | **PASS (live-proven on DEV and production), with 2 disclosed residual limits carried forward -- was FAIL, then CONDITIONAL PASS, now upgraded on live evidence** |
| R21 | Stale/repeated/concurrent Apply safe | True concurrency (card/loan/income/retirement/WP-15) | Reused | None identified | 1 write, 1 safe rejection, never 2 writes | **PASS** (reused) |
| R22 | Duplicate/overlapping uploads -> 0 duplicate effects | SUI S3 (byte-identical + re-exported statements) | Reused | None identified | 0 new rows on duplicate | **PASS** (reused) |
| R23 | User corrections/splits propagate | `scenario_split_correction.ts` | Reused | None identified | Correction reaches every consumer | **PASS** (reused) |
| R24 | UNKNOWN never silently categorised | `scenario_unknown.ts` | Reused | None identified | Honest review state preserved | **PASS** (reused) |
| R25 | Field-disposition registry enforced in CI | As R1; STRICT on | Reused | None identified | An orphan field fails certification | **PASS** (reused) |
| **R26** | **Golden pair: $0 unexplained variance, manual vs. imported** | **Every dollar figure $0 different; Score/Twin diverge (fixture artifact)** | **Reused: Stage 3 FINAL live re-run. PO decision 2026-09-28 (commit 62b0120) accepted the gap as designed** | **See mission section 8 analysis below -- independently assessed this session, not re-run from scratch** | Every canonical financial figure exactly equal; documented (not masked) history-semantics differences elsewhere | **PASS-with-disclosure, PO decision reviewed and independently assessed CONSISTENT this session (see section 8 note)** |
| R27 | Scale: 1,000/1,001 lines, no truncation, no duplicate | SUI S1-S3 | Reused | None identified | Every layer, every total correct at scale | **PASS** (reused) |
| R28 | Discoverability (Expenses/Retirement import entry points) | SUI U9; fdh14 e2e 6/6 | Reused | None identified | Entry points reachable from the real tab | **PASS** (reused) |
| R29 | The nine programme documents exist | All nine under `docs/financial-data-hub/` | Reused, spot-checked present this session | None identified | Documents exist and are current | **PASS** (reused) |
| R30 | Production certification | Plan only (`PRODUCTION_IMPORT_PROPAGATION_CERTIFICATION.md`) | Not run | Full production journey verification (mission sections 16-17) | Real synthetic-account journeys succeed in production, visibly | **NOT RUN** (unchanged this session -- see "Session status") |

**Reconciled count: 21 PASS + 6 PASS-with-disclosure + 1 CONDITIONAL PASS
(R20, upgraded from FAIL by this session's code fix, still blocked on
deployment) + 1 PASS-with-disclosure-and-independently-reviewed (R26) + 1 NOT
RUN (R30) = 30.** (R20 moved out of the strict PASS-with-disclosure bucket
into its own conditional line because its status materially changed this
session; the arithmetic still totals 30.)

### R20 detail (the two RE-CONFIRMED residual provenance gaps, and this session's fix)

| Sub-ID | Original defect (live-reproduced, 2026-09-27) | Fix this session | Verification this session | Remaining work | Result |
|---|---|---|---|---|---|
| R20-A | WP-15 expense proposal: a $999,999.99/month planned-expense figure, labelled bank-derived, with **no real transaction behind it**, applied successfully via `fdh15_apply_expense_proposals` | `supabase/migrations/0224_aie1_canonical_close_r20_provenance_gaps.sql`, Part B: `fdh15_apply_one_expense_proposal` now refuses to apply an `amount` field for a `target_domain='expense'`/`source_kind='bank_statement'` proposal unless the user has >=1 real APPROVED same-currency expense transaction in the proposal's own window, and the proposed monthly figure does not exceed the user's TOTAL real approved expense spend in that window | `scripts/canonical_0224_pglite_verification.mjs`: anti-vacuity (forged proposal applies BEFORE 0224) -> refused AFTER 0224 (`NO_SUPPORTING_TRANSACTIONS`); a proposal exceeding real evidence also refused (`PROVENANCE_UNVERIFIED`); a proposal within real evidence still applies and the target row's value genuinely changes. 12/12 checks pass | **Not yet applied to DEV or production** (BLOCKED -- PO must run it; see handoff). Known, disclosed, deliberate limit: this is a bound/existence check against real evidence, not a re-derivation of the TS engine's category-mapping/FX/coverage logic in SQL (doing so would itself be a second, independent calculation source, which the mission's binding architecture forbids) -- it cannot detect a forged amount that happens to fall inside the user's real total window spend, and it compares same-currency evidence only (a genuine multi-currency proposal could be false-refused, never false-accepted) | **FIXED IN CODE, PGLITE-PROVEN, NOT DEPLOYED** |
| R20-B | `fdh10_persist_liability_statement` (SECURITY INVOKER): an ordinary, unprocessed bank-CSV upload (`document_type='bank_statement'`) turned into a fabricated $499,999.99 loan-payoff statement | Same migration, Part A: the function now looks up the source document's own `document_type` and refuses unless it matches the `statement_type` being persisted (`credit_card_statement` <-> `credit_card`, `loan_statement` <-> `loan`) | Same script: anti-vacuity (forgery succeeds BEFORE 0224) -> refused AFTER 0224 (`DOCUMENT_TYPE_MISMATCH`) for both a loan-on-bank-doc and a credit-card-on-bank-doc attempt; legitimate credit-card and loan persists (right document class) still succeed; a credit-card document cannot become a loan statement either | **Not yet applied to DEV or production** (BLOCKED). Disclosed, deliberate limit, same as the report's own open item: this function remains SECURITY INVOKER and still trusts every NUMBER in the payload at face value for a document of the CORRECT class -- it closes the document-CLASS confusion exploit specifically (the one named and reproduced live), not a theoretical forging of numbers against the user's own correctly-classed document. That residual needs either a service-role persist path that re-derives from the durable parsed-extraction record, or an equivalent control, and remains open | **FIXED IN CODE, PGLITE-PROVEN, NOT DEPLOYED** |

## 2. Mission section 8 -- Score/Twin equivalence: independent review of the PO's 2026-09-28 decision

The PO's decision (commit `62b0120`, reasoning quoted in
`FINAL_COMPLETION_REPORT.md`'s R26 row and "open PO decisions" table) is that
the measured Score/Twin gap (45.521 vs 46.244) is a **fixture-data artifact**
(a stale historical `financial_snapshots` row from an earlier certification
run, corrected only by an approved import, never manual entry), not a genuine
same-user inconsistency -- and that this mirrors the existing, accepted
null/error-!=-0 principle (R16): a household that has supplied real historical
evidence legitimately scores differently from one that has only asserted
today's numbers.

**This session's independent assessment (review of the existing evidence and
reasoning, not a from-scratch rebuild of the two households -- see "Session
status" for why):** the report's own account is internally consistent and
falls on the right side of the R16 precedent it cites -- "an approved import
retroactively corrects a stale historical month; manual entry does not touch
history" is a real, disclosed, asymmetric CAPABILITY difference, not a
calculation defect, PROVIDED every current-period canonical figure is truly
identical between the two households (which the golden-pair re-run in Stage 3
FINAL claims, at $0 variance, across income/expenses/assets/liabilities/
investments/retirement/net worth/cashflow/all 6 forecasts/report). This
session did **not** independently reconstruct the two households from scratch
with its own oracle (mission section 8's "build two controlled households...
using independently constructed expected values" was not re-run this pass) --
so this is a **review of the existing proof's reasoning and internal
consistency**, not a fresh, independent re-proof. It does **not** contradict
the PO's decision; it also does not add new evidence beyond what
`FINAL_COMPLETION_REPORT.md` already contains. Follow-up items this session
did NOT verify: the `neutralise.mjs` certification-harness fix (adding a
`financial_snapshots` reset step) that the PO's decision names as the
tracked, test-infrastructure-only follow-up.

**Verdict on this specific mission item: PASS (reviewed, not re-litigated)** --
per the mission's own instruction, "If your own independent build-two-
households proof CONFIRMS that decision was correct, say so... do not silently
discard prior verified work," this session found no basis to discard it, and
did not perform a full independent re-proof strong enough to either overturn
it or add a stronger confirmation than what already exists.

## 3. Smaller open items (the "approximately twelve" from the mission text)

`FINAL_COMPLETION_REPORT.md`'s "Open PO decisions" table has 16 rows; one
(Score/Twin) is now RESOLVED per section 2 above. The remaining 15 are listed
here with a stable ID for this register. **None of these were acted on this
session** (see "Session status") -- they are carried forward, not silently
narrowed out, per mission section 3's explicit instruction not to call an item
minor just because a prior summary did.

| ID | Item | Status this session |
|---|---|---|
| SPD-01 | D-08: manual revolving cards contribute $0 debt service (vs. agent's suggested estimated-interest formula) | NOT STARTED (mission section 7 target) |
| SPD-02 | GAP-09: null net pay no longer falls back to gross per row -- confirm | NOT STARTED |
| SPD-03 | Pension PAYMENT -> income, WITHDRAWAL -> transfer -- confirm | NOT STARTED |
| SPD-04 | Premium report: investment chapter reports unavailable when FX rate unreadable -- confirm | NOT STARTED |
| SPD-05 | Unsplit loan PAYMENT recorded as a transfer -- confirm | NOT STARTED |
| SPD-06 | Rule 10 (SUI-2): ordinary-account credit of a spending type = refund only with a confirmed link -- confirm semantics | NOT STARTED |
| SPD-07 | WP-15 forge (R20-A) -- re-derive/lock down expense-average proposal generation | **PARTIALLY ADDRESSED this session** -- see R20-A above (apply-time evidence bound, not full server-side generation lockdown) |
| SPD-08 | SR-01 residual (R20-B) -- `fdh10_persist_liability_statement` SECURITY INVOKER, trusts caller numbers for a correctly-classed document | **PARTIALLY ADDRESSED this session** -- see R20-B above (document-class check only) |
| SPD-09 | ~~Score/Twin fixture asymmetry~~ | **RESOLVED** (PO, 2026-09-28); independently reviewed this session, see section 2 |
| SPD-10 | D-07: unlinked bank income credits added as "other income" with a duplicate prompt; split deposits/bonus months evade it | **ROOT CAUSE PRECISELY DIAGNOSED this session** (see section 6 below): the 5%-of-full-amount match in `lib/read-models/income.ts`'s `computeIncome` never fires for a multi-leg split deposit, since no single leg is within 5% of the full planned amount. NOT FIXED -- needs a PO decision on the grouping/tolerance rule first (isolated as an explicit open decision, not guessed at) |
| SPD-11 | GP-O1: manual grids allow only one catalogue row per item type | NOT STARTED |
| SPD-12 | GP-O3: expense-averages proposal cannot target a subcategory the review page can't pick (rent/housing never proposed) | NOT STARTED |
| SPD-13 | Combined-basis group displacement (a group's actuals replace its whole plan) -- confirm or blend | NOT STARTED |
| SPD-14 | Dashboard summary timing: 23-39s vs 28s Amplify limit; 110 DB round trips, ~70 from unnecessary 100-id chunking | **FIXED AND LIVE-PROVEN this session** -- see section 5 below (mission section 9). Pure application-code read-pattern change, no migration needed. On branch, not yet merged/deployed |
| SPD-15 | Suspected P3: `debt_interest` on an ORDINARY bank account double-counted with contractual repayment (security review; not proven live) | NOT STARTED |
| SPD-16 | Per-country Net Worth sums differ from Net Worth by the investments total | NOT STARTED |
| SPD-17 | 7 synthetic fixture `financial_snapshots` rows (Aug 2026) still carry certification-run cash-flow values | NOT STARTED (data-cleanup item, mission section 18) |

## 4. Mission-section coverage map (sections 4-19)

| Section | Topic | This session |
|---|---|---|
| 4 | Binding architecture preserved | Respected: 0224 adds no second parser/writer/calc source; explicitly reasoned about and rejected a SQL re-derivation of the WP-15 average for exactly this reason (see 0224's own header). 0225/0226 (part 3, below) are additive-only in the same spirit |
| 5 | Source-provenance vulnerabilities | Worked in part 2; not this dispatch's assignment (part 3 was explicitly scoped to sections 6, 7, 11-19) |
| 6 | Field-to-canonical traceability | **WORKED THIS SESSION (part 3)** -- see section 9 below |
| 7 | Manual/imported credit-card consistency | **WORKED THIS SESSION (part 3)** -- see section 10 below. One real code-level bug found and fixed (`monthly_repayment` defaulting to a genuine 0) |
| 8 | Score/Twin equivalence | Reviewed in part 1; not this dispatch's assignment |
| 9 | Dashboard performance | Fixed and live-proven in part 2; not this dispatch's assignment |
| 10 | Remaining integration defects | Worked in part 2; not this dispatch's assignment |
| 11 | AIE security controls (malware/cost RPC) | **WORKED THIS SESSION (part 3)** -- see section 11 below. One real, currently-open gap found and fixed (migration 0225); cost-RPC controls independently re-verified already closed (0195) |
| 12 | Real GPT-4o mini + privacy proof | **PARTIALLY WORKED THIS SESSION (part 3)** -- see section 12 below. Real DEV evidence independently re-confirmed (not newly generated); full fresh end-to-end journey not re-run this pass (budget) |
| 13 | PDF deletion + durable review proof | **WORKED THIS SESSION (part 3)** -- see section 13 below. Real, live, independently-verified production evidence obtained (not merely code review) |
| 14 | II review + PC5 | **PARTIALLY WORKED THIS SESSION (part 3)** -- see section 14 below. A precise, already-disclosed gap confirmed by reading the code itself: PC5 does not actually consume AIE's unresolved-item queue in production |
| 15 | Accessibility + released scope | NOT STARTED this session (tooling identified: `@axe-core/playwright` + several existing live-DEV a11y scripts under `scripts/`; not run this pass -- budget) |
| 16 | Deployment + production proof | NOT STARTED this session beyond identity checks -- see section 15 below (this environment cannot merge to `main` or apply migrations; see handoff) |
| 17 | Production test matrix | NOT STARTED as a full matrix this session; a small number of proportionate, read-only production checks were done as part of section 13 (see below) |
| 18 | Observation/cleanup/rollback | NOT STARTED this session beyond noting the synthetic-manifest discipline already established in parts 1-2; no new synthetic data was created this pass (all section 12/13 evidence was obtained by READING existing DEV/production data, not by creating new test accounts or objects) -- see section 16 below |
| 19 | Final certification | **NOT ATTEMPTED this session.** Sections 8, 9, 10 (part 2), and R30/production-deploy verification (mission section 16-17) are not this dispatch's own fresh work, and sections 15/17/18 remain materially incomplete -- a certification written now would round up. See the top-level handoff for exactly what a part 4 would need |

## 5. Mission section 9 -- Dashboard performance (SPD-14): root cause re-derived, fixed, live-proven

**Root cause, independently re-derived (not trusted from the prior report's note).** Code inspection of
`lib/read-models/core/ledger.ts` (`loadApprovedLedger`, `loadUserDecisionTimes`) and
`lib/read-models/corroboration.ts` (`loadCorroborationEvidence`) confirmed exactly the call sites the
reused report named: `fdh_transaction_links` (both directions), `fdh_transaction_allocations`,
`fdh_transaction_corrections`, `fdh_payroll_events`, `fdh_liability_statement_activities`,
`fdh_investment_statement_activities` and `fdh_retirement_statement_activities` were all read via
`fetchAllByIds()` -- chunking the caller's up-to-1,000 known transaction ids into groups of 100 and
issuing one PostgREST request per chunk (`lib/read-models/core/paginate.ts`'s `ID_CHUNK_SIZE = 100`) --
even though every one of these queries is already scoped with `.eq('user_id', userId)`, and every one of
these tables only ever holds a row for a transaction that has actual evidence (a link, a split, a
correction, a matched statement activity), never one row per transaction. Chunking by transaction id was
therefore not load-bearing: it produced up to `ceil(1000/100) = 10` round trips per table (20 for the
two-directional links query) regardless of how many rows actually existed.

**Fix.** Each of these reads now fetches the whole per-user table (still paged at PostgREST's 1,000-row
cap via `fetchAllRows`) and filters the caller's known-id set client-side with a `Set`, instead of chunking
the `.in()` filter by id. `fdh_transactions` itself (the one table that can genuinely hold a user's entire
history, not just evidenced rows) was deliberately left on `fetchAllByIds` for its one remaining id-scoped
lookup (cross-window linked transactions) -- this fix does not introduce a full-history read anywhere the
mission warns against. Changed files: `lib/read-models/core/ledger.ts`,
`lib/read-models/corroboration.ts`. No migration, no schema change, no new calculation source -- a pure
read-pattern change preserving the binding architecture (mission section 4).

**Correctness proof (deterministic, independent of any live environment).**
`tests/unit/readModels/dashboardRoundTripReduction.test.ts` (new): builds a 1,000-approved-transaction
fixture with real links/allocations plus deliberate decoys (a different user's rows in the same tables; a
transaction id outside the known set), and asserts (a) the fixed `loadApprovedLedger` returns the exact
expected rows with decoys excluded and cross-window linked transactions still resolved; (b) the fixed
`loadCorroborationEvidence` returns output byte-identical (`toEqual`) to a frozen, independently-written
copy of the OLD chunked implementation (kept in the test file only, never imported by application code) --
an equality oracle that does not share the new code's own logic; (c) round trips for the targeted tables
drop by 60+ at 1,000 ids, consistent with the reused report's own estimate. Full targeted suite
(`tests/unit/readModels`, 14 files): **125/125 pass** (was 122/122 before this session added 3 new tests) --
every pre-existing scenario oracle (income/expense/liability/investment/retirement, the rule-9
later-evidence-wins security fix, currency fail-closed, pagination) still passes unchanged.
`tsc --noEmit`: 0 errors in either changed file (confirmed by isolating the grep to `ledger.ts`/
`corroboration.ts`; one real pre-existing-pattern null-handling error this fix introduced was caught and
fixed in the same pass -- `fdh_transaction_links.transaction_id_to` is nullable and the new client-side
filter needed the same null guard the original cross-window-id computation already had). ESLint could not
be run in this worktree this session (pre-existing environment breakage: `npx eslint` fails with a
`hermes-parser` native-module `SyntaxError` even on a completely untouched file, confirmed not caused by
this change) -- disclosed, not claimed clean.

**Live-DEV proof (real, not simulated), re-deriving the reused report's own "~110 round trips / 23-39s at
1,000 transactions" claim exactly, using the existing `scripts/canonical_cert/` harness
(`dev_server.mjs --count-requests` + `scale_journey.ts`) plus two new disposable synthetic accounts
(`perfsc9-<stamp>@fhip-synthetic.test`, never part of the shared FCAST/E2E50 fixture pool, own port 3980
to avoid colliding with any other concurrent session):**

| Scale | Metric | BEFORE (pre-fix code, same commit as `origin/main`) | AFTER (this session's fix, same user/data) |
|---|---|---|---|
| n=300 approved bank transactions | `GET /api/dashboard/summary` Supabase round trips | 58 | 43 |
| n=300 | wall-clock | 7,943 ms (post-approve, effectively cold) | 5,402-5,407 ms (warm, 2 samples) |
| n=1,000 approved bank transactions (the report's own tested scale) | `GET /api/dashboard/summary` Supabase round trips | **108** | **44** |
| n=1,000 | wall-clock | **17,763 ms** (post-approve) | 7,394 ms (cold) / 5,666-5,843 ms (warm, 2 samples) |
| n=1,000 | financial output | `bankMonthlyExpenses=413100`, `bankMonthlyIncome=0`, `totalMonthlyExpenses=413100`, actuals `lineCount=900`, `actualMonthly=413100` | **identical, byte-for-byte, to the pre-fix values** -- the equality proof mission section 9 requires |

Method: for each scale, the pre-fix measurement came from running the ORIGINAL (unmodified,
`git checkout HEAD --`) `ledger.ts`/`corroboration.ts` through the real upload -> detect -> process ->
categorise -> approve-all journey via the real app routes (not a hand-rolled re-implementation), with the
Next.js dev server pointed at DEV and `--count-requests` instrumenting every outgoing Supabase fetch
(`scripts/canonical_cert/count_supabase_requests.cjs`, pre-existing harness tooling, unmodified). The fix
was then restored, the dev server restarted (fresh process, no in-memory carry-over), and
`GET /api/dashboard/summary` re-observed for the SAME already-populated synthetic user with a new small
script (`scripts/canonical_cert/reobserve_dashboard.mjs`) -- so the "after" measurement reads the exact
same underlying data the "before" measurement produced, not a fresh, potentially-different dataset.
108 -> 44 round trips (59% reduction) and 17.8s -> ~5.7-5.8s warm (a further ~2x beyond the round-trip
reduction alone, consistent with each eliminated round trip having non-trivial per-request latency to
hosted DEV) match the reused report's own estimate ("estimated to remove 60-70 of the ~110 round trips at
1,000 transactions") almost exactly -- an independent re-derivation, not a re-assertion of the prior claim.

**What this does NOT establish.** These are localhost-to-hosted-DEV timings, not a production Amplify
measurement (mission sections 16-17 remain the place for that, and remain blocked on an actual Amplify
deploy of this fix). Only `dashboard/summary`'s round-trip/timing profile was re-measured this session;
`expenses/actuals` (also heavy per the reused report: 17-25s) shares the same `loadApprovedLedger` call
path and would see the same reduction, but was not separately isolated as a headline metric here (its
p50/timing is visible in the raw evidence files `test-artifacts/canonical_cert/perf-pre-300.json` and
`perf-pre-1000.json` but not independently asserted). Sample count is 2 warm runs per scale, not enough for
a statistically rigorous p95 -- correctly stated per the mission's "do not claim a reliable p95 from an
inadequate sample": this is a real, live, reproducible before/after proof at two scales, not a
statistically powered latency study. "Small" and "medium" household scales (per mission section 9's
explicit ask) were not separately measured; n=300 stands in as the smaller of the two scales tested.

**Cleanup.** Both synthetic users (`perfsc9-1790566026008282@...` n=300, `perfsc9-1790566381305950@...`
n=1,000) fully deleted via `scripts/canonical_cert/perf_synthetic_user.mjs cleanup`: 0 residual rows across
all 10 tables checked, auth user lookup returns 404 for both. No `.canonical-cert/` session/state files
retained (gitignored working directory; local scratch files also removed manually).

**Verdict on SPD-14 / mission section 9: FIXED, live-proven at the report's own tested scale, NOT YET
DEPLOYED.** Merge + Amplify deployment + a genuine production-load measurement remain open (mission
sections 16-17).

## 6. Mission section 10 -- remaining integration defects (this session's investigation)

Each of the six named items was investigated this session by reading the actual current implementation
(not by trusting the reused report's characterisation). Four are found ALREADY CORRECTLY CLOSED in the
current code (verified this session, with the specific evidence each claim rests on); one is a genuine,
precisely-diagnosed open gap; one (report-display edge cases) was not reached this session.

| Item | Finding this session | Verdict |
|---|---|---|
| Bank cash-withdrawal classification | `lib/read-models/core/spendingRules.ts`: `cash_withdrawal` is a `NON_SPENDING_BUCKET`, labelled "Cash — spending unknown" (line ~300), excluded from the spending total, never guessed as consumption and never double-counted against a later unrelated cash spend (there is no downstream cash-spend tracking to double count against). Regression coverage: `tests/unit/readModels/expensesOracle.test.ts`, `creditOnSpendingType.test.ts`, `spendingRulesParity.test.ts`. | **ALREADY CORRECT, verified this session.** No fix needed |
| Zero-amount liability lines / orphaned statement rows | `assertPersistableLiabilityActivities()` in `lib/financial-data-hub/services/liabilityStatementProcessingService.ts` refuses to persist ANY statement containing a non-positive-amount or invalid-split line (a controlled `invalid_state` error, "this statement was not saved" -- the whole statement, not a partial write). `supabase/migrations/0208_fdh10_atomic_liability_statement_persist.sql` makes the actual DB write ONE atomic transaction (statement + every activity + the `queued -> processing -> extracted` status steps) under a per-document advisory lock, refusing a second statement with `EVIDENCE_EXISTS` -- this is the forward-port of the exact defect the 2026-09-25 session's memory recorded (a `0.00` CSV line left an orphaned zero-activity statement row with the document stuck `queued`), now correctly renumbered and present in this branch's `supabase/migrations/` (confirmed: `0208` exists; the old `0198` number the unmerged branch used does not, exactly as 0208's own header documents doing on purpose). `tests/unit/fdh10LiabilityZeroAmountAtomicPersist.test.ts`: 15/15 pass. | **ALREADY FIXED, present in this branch's migration history, verified this session.** Not independently re-confirmed live on DEV/production this pass (that would need OPS-1-style live re-probing of 0208 specifically -- not done) |
| Retirement lines classified UNKNOWN | `lib/financial-data-hub/retirement/activityClassification.ts`: an unmatched line becomes `UNKNOWN` with a `null` balance direction, which excludes it from the reconciliation identity -- forcing the statement to an honest `VARIANCE`/`INSUFFICIENT_DATA` result rather than a confidently wrong `RECONCILED`. Exact-code lines (a statement that already prints its own activity-type code) are matched exactly, not guessed. No amount-based guessing anywhere in the classifier. | **ALREADY CORRECT, verified this session.** Matches R24's existing PASS ("UNKNOWN never silently categorised") for the retirement domain specifically |
| Retirement audit persistence | Confirmed the Stage 3 FINAL pass's fix (three call sites using the statement's own id instead of its uploaded-document id, breaking the `fdh_document_audit_events.document_id` FK) is present in the CURRENT code: `lib/financial-data-hub/services/retirementStatementProcessingService.ts` (2 call sites, explicit comment naming the fix) and `lib/retirement-import-bridge/retirementAccountResolution.ts`. `tests/unit/fdh12RetirementHistory.test.ts`: 22/22 pass. | **ALREADY FIXED, present in this branch, verified this session** (independently re-checked, not just trusted from the reused report) |
| Correction / rejection / duplicate / superseded-document behaviour | Spot-checked (not a full re-audit): `tests/unit/fdh10LiabilityCorrection.test.ts`, `payslipDuplicateAndResume.test.ts`, `payslipBankRematch.test.ts` -- 62/62 pass. Consistent with the register's existing reused R21-R23 PASS rows. | **Spot-verified consistent with existing PASS evidence.** Not a full independent re-audit against every document class this session |
| Split-deposit income detection (D-07 / SPD-10) | **Root cause precisely identified this session** (was previously only described at a summary level). `lib/read-models/income.ts`'s D-07 "possible duplicate" prompt only fires when ONE unlinked bank credit's amount is within 5% of a planned source's per-occurrence amount (`computeIncome`, the `possibleDuplicateOf` filter). A split deposit -- the same pay event landing as two or more separate bank credits (e.g. $3,000 + $2,000 for a $5,000 net-pay source) -- means NEITHER individual credit is within 5% of the full planned amount, so the flag never fires for either leg: both are silently counted as ordinary "other income" with no duplicate warning, which can overstate actual income against the planned salary it is really the same money as. This is a genuine gap, not yet fixed. | **NOT FIXED.** A correct fix requires a genuine, currently-undocumented product decision (mission section 7's own precedent for "a material formula decision genuinely absent from the approved product contract" applies equally here): what time window groups candidate split legs (same day? same statement period? same employer-description prefix?), what tolerance the GROUP sum must match the planned amount within, and how it should be surfaced (a single combined prompt across N lines, vs. per-line). Implementing a heuristic without that decision risks a worse defect (false-positive grouping of coincidentally-similar unrelated credits, silently hiding real income) more than it risks leaving the gap open. **Isolated as an explicit open decision, not silently narrowed out or guessed at.** |
| Report-display edge cases | Not investigated this session (no specific edge case was named in the reused report beyond the general item; budget went to the other five, more concretely specified items plus section 9). | **NOT STARTED this session** |

**Verdict on mission section 10 overall: PARTIALLY WORKED.** 4 of 6 named items independently verified
already correct/fixed in the current code (not merely reused-trusted); 1 has its root cause precisely
diagnosed with the exact reason a full fix is deferred (a genuine open product decision, not a budget
shortcut); 1 (report-display edge cases) not reached. No new code changes were needed or made for this
section this session -- the value delivered was verification (closing 4 items with real evidence they no
longer needed to be treated as open) and one precise, actionable diagnosis (D-07/SPD-10).

## 7. Operator-blocked items (OPS-)

| ID | Item | Why blocked |
|---|---|---|
| OPS-1 | Independently re-confirm 0218 is applied and enforcing on DEV | This session's environment has DEV read (service-role) access but did not re-run a live forgery/refusal probe against 0218's specific triggers this pass; the 2026-09-27 report's own claim ("0218 is not yet applied on DEV") was not re-checked |
| OPS-2 | Apply migration 0224 to DEV, then production | This environment cannot execute DDL against either database (standing constraint). File delivered; see handoff |
| OPS-3 | Confirm the actual deployed production SHA/build identity | No Amplify console/API access in this environment (same blocker as prior sessions) |
| OPS-4 | Live-DEV/production re-proof of R20-A/R20-B after 0224 is applied | Requires OPS-2 first |

## 8. Session status (honest, per the mission's own anti-rounding-up instruction)

**PART 1 (earlier this session's lineage, commits through `6c0cca4`) did:**
1. Re-verified the mission's reported baseline against the real repository and
   DEV state, found and recorded the drift (section 0 above).
2. Built this closure register, reconciling the reported 30-item arithmetic
   and carrying forward all ~16 smaller open items without narrowing scope.
3. Independently reviewed (not re-proved from scratch) the PO's Score/Twin
   decision and found it internally consistent -- did not discard or
   re-litigate it.
4. Fixed, at the code level, BOTH of R20's re-confirmed residual provenance
   gaps (migration `0224_aie1_canonical_close_r20_provenance_gaps.sql`),
   with a real anti-vacuity PGlite proof (12/12).

**Since part 1 (recorded here, done in the current session but by the main
session rather than this dispatch):** migration `0224` was applied to DEV and
production by the PO, and both R20-A and R20-B were independently
live-exploit-proven BLOCKED on BOTH environments using disposable synthetic
accounts (full user-scoped sessions, not service-role bypass) -- cleanly
cleaned up, zero residue. R20's register rows above are updated accordingly
(PASS, not just CONDITIONAL PASS).

**PART 2 (this dispatch) did:**
1. Mission section 9 (dashboard performance / SPD-14): independently
   re-derived the ~110-round-trip root cause (did not trust the prior note),
   fixed it in `lib/read-models/core/ledger.ts` and
   `lib/read-models/corroboration.ts` (pure read-pattern change, no
   migration), proved it deterministically (new test file, 125/125 full
   suite) AND live on DEV at two real scales (300 and 1,000 approved bank
   transactions) using two disposable synthetic accounts, both fully cleaned
   up: 108 -> 44 round trips / 17.8s -> ~5.7s warm at 1,000 transactions,
   financial output byte-identical before/after. See section 5 above.
2. Mission section 10 (remaining integration defects): investigated all six
   named items. Four (cash-withdrawal classification, zero-amount liability
   lines/orphaned rows, retirement UNKNOWN classification, retirement audit
   persistence) independently verified ALREADY CORRECT/FIXED in the current
   code, not merely reused-trusted from a prior report. One
   (correction/rejection/duplicate/supersession) spot-verified consistent
   with existing PASS evidence. One (split-deposit income detection, D-07 /
   SPD-10) precisely root-caused (the exact reason the existing duplicate-flag
   heuristic misses a multi-leg split deposit) but deliberately NOT fixed,
   pending a genuine, currently-undocumented PO decision on the
   grouping/tolerance rule. Report-display edge cases not reached. See
   section 6 above.
3. Confirmed no regression: `tests/unit/readModels` 125/125; full repo suite
   9,667 passed / 20 failed / 5 skipped, and the 4 failing files (admin
   analytics coupling detector, AI residual closure negative control, country
   gate account-deletion route discovery, Resources R1.1 RLS timeout) were
   independently confirmed to fail in isolation too and share no file overlap
   with this session's changes -- pre-existing, consistent with this repo's
   own documented "full vitest run" hazards, not introduced this session.
   Reverted the certification-artifact files (`scripts/**/*.json`,
   `results_table.md`) the full run rewrote, per the standing hazard note.
4. Committed incrementally: `359a1f8` (section 9 fix + tests + register
   updates).

**What this session explicitly did NOT do** (mission sections 6, 7, 8 beyond
the existing reviewed decision, 11-19, and R30): field-to-canonical
traceability mapping (section 6), the credit-card manual/imported
consistency shared rule (section 7, SPD-01/SPD-05 still open), a fresh
from-scratch Score/Twin two-household rebuild (section 8 -- part 1's review
of the existing proof stands, not re-litigated further), AIE security-control
verification (section 11), real GPT-4o mini/privacy proof (section 12),
PDF-deletion proof (section 13), PC5/II review completion (section 14),
accessibility verification (section 15), actual deployment of ANY change to
DEV/production (both this session's fix and migration 0224 sit on this
branch; 0224 itself has been separately applied and live-proven by the PO as
described above, but the branch as a whole is not merged), the full
production test matrix (section 17), observation/rollback readiness (section
18), or a final certification (section 19, R30). None of these are claimed
done.

**Exact next action needed from the PO:**
1. Review and merge this branch (`aie1-canonical-closure-20260928`) to `main`
   -- see the top-level handoff message for the exact two-command sequence,
   since this environment cannot push to `main` directly. It contains: the
   0224 provenance fix (already applied+live-proven on DEV/production
   independently of the branch merge), this session's dashboard round-trip
   fix (code-only, not yet applied anywhere beyond this branch), and the
   updated closure register.
2. After merge and Amplify deployment, a genuine production-load timing
   measurement for `GET /api/dashboard/summary` remains open (mission
   sections 16-17) -- this session's proof is real and live but is
   localhost-to-hosted-DEV, not a production Amplify measurement.
3. A product decision is needed on the split-deposit (D-07/SPD-10) grouping
   and tolerance rule before that gap can be closed (section 6 above) --
   isolated as an explicit open decision, not guessed at.
4. Decide whether a further session should continue with mission sections 6,
   7, 11-19 (a large amount of work remains) or whether the PO wants to
   re-prioritize a subset first.

---

# PART 3 (this dispatch) -- mission sections 6, 7, 11-19

Branch: `aie1-canonical-closure-20260928` (continued from part 2's `176bb61`,
which is identical to `origin/main` at dispatch time -- independently
re-confirmed: `git rev-parse origin/main` == `git rev-parse HEAD` == `176bb61`
at the start of this dispatch). PO explicitly assigned sections 6, 7, and
11-19; sections 8, 9, 10 were already worked in parts 1-2 and are out of this
dispatch's scope unless something in them directly blocked an assigned
section (nothing did).

**Method note (read before the sections below):** four read-only
investigation passes (sections 6, 7, 11, 13) were run as independent
sub-investigations reading the actual current code, not the prior register's
characterisation of it, per this mission's own "independently re-verify
load-bearing claims" instruction (constraint 8). Each one is marked below as
either independently re-confirmed by this main session (a live query, a test
run, a migration written and PGlite-proven) or reported by the
sub-investigation and taken at the level of confidence it itself claimed
(code-verified vs. inferred vs. "needs live testing"). Where a
sub-investigation's exploit narrative turned out, on this session's own
follow-up check, to be narrower than first described, that correction is
recorded explicitly rather than silently adopting the stronger claim.

## 9. Mission section 6 -- field-to-canonical traceability

**Registry state, independently re-confirmed this session (not reused from R1/R25 without re-checking):**

| File | Entries | Open gap | not_active |
|---|---|---|---|
| bankStatement | 162 | 0 | 0 |
| economicTransactionType | 13 | 0 | 0 |
| payslip | 130 | 0 | 0 |
| liabilityStatement | 145 | 0 | 0 |
| liabilityActivityLedger | 10 | 0 | 0 |
| auInvestmentStatement | 168 | 0 | 0 |
| retirementStatement | 203 | 0 | 0 |
| iiCas | 41 | 0 | 0 |
| insurance | 21 | 0 | **21 (all)** |
| **Total** | **893** | **0** | **21** |

- `STRICT_CERTIFICATION = true` (`lib/canonical-data/disposition/index.ts:49`).
- All 8 required upload classes have registry coverage. Credit card and loan
  share `liabilityStatement.ts` (+ `liabilityActivityLedger.ts`), distinguished
  by `facilityType`/`statementType`. Insurance's 21 entries are ALL
  `not_active` -- confirmed by independently checking that no
  insurance-to-canonical "apply" route exists anywhere under `app/api`
  (only a plain manual CRUD route against `insurance_policies`, unrelated to
  AIE) -- this matches R12's already-disclosed "explicitly narrow scope", not
  an oversight.
- **CI gate re-run this session** (not merely cited): `npm run check:dispositions`
  equivalent (`tests/unit/uploadFieldDispositionRegistry.test.ts` +
  `...AntiVacuity.test.ts` + `tests/unit/inactiveUploadFlowGuard.test.ts`) --
  **36/36 pass**, matching both prior reports' own "36/36" figure exactly via
  independent re-execution. The anti-vacuity suite (21 tests) proves the gate
  is non-vacuous: it injects an orphan TS property, an orphan zod key, an
  added-but-undisposed migration column, a stale/removed/duplicated entry, an
  injected enum value, and a re-opened gap, and confirms each is actually
  caught. The registry's "real" side is re-derived every run from the live
  source tree (TS AST parsing, live zod `.shape` introspection, and a
  hand-written SQL-migration-ledger replayer that reconstructs every table's
  column list from `supabase/migrations/`) -- not a second hand-written list
  the registry could vacuously agree with.
- **Writer/RPC chain confirmed per class** (persist -> approve -> apply):
  bank (`fdh7_bulk_approve_transactions`, approval flips the canonical flag
  directly, no separate apply RPC), payslip (`fdh9_approve_payroll_event` /
  `fdh9_apply_income_proposal`), credit card/loan
  (`fdh10_persist_liability_statement` -- hardened by 0224's document-type
  check -- / `fdh10_approve_liability_statement` / `fdh10_apply_liability_proposal`),
  retirement (`fdh12_approve_retirement_statement` /
  `fdh12_apply_retirement_proposal`), AU investment (app-code writer:
  `applyAuStatementActivity`/`applyAuStatementPosition` +
  `certifyAuPosition`, no single DB RPC), II/CAS
  (`aiExtractionReviewApply.ts`), insurance (intake only, no apply path,
  consistent with `not_active`).
- **Dropped-field hand cross-check** (bank statement, credit card/loan,
  retirement -- the three classes this session picked for a genuine manual
  diff, not just trusting the passing gate): read the actual TypeScript
  extraction-output interfaces (`NormalizedTransactionCandidate`,
  `AcceptedPdfTransactionPlan`, `LiabilityStatementExtraction` +
  `LiabilityStatementActivity`, `RetirementStatementExtraction` +
  `RetirementActivityEvidence` + `RetirementPositionEvidence`) field-by-field
  against the generated registry doc. **Zero dropped/orphan fields found** in
  any of the three. AU-investment and II-CAS TS interfaces, and the DB-column
  sources for every class, were NOT separately hand-diffed this session
  (relied on the gate's own non-vacuous live-tree parsing instead) -- a
  residual piece of independent verification a future pass could still add.
- **Staging-before-approval isolation, independently confirmed by reading
  code**: `loadApprovedLedger()`/`corroboration.ts` filter bank, liability,
  payslip and retirement evidence by `approval_status`/`processing_status =
  'approved'` before any downstream read model sees it. AU
  investment/II achieve the same property architecturally (staging tables
  `fdh_investment_statement_activities`/`positions` carry `apply_status`, and
  a repo-wide grep found **zero** downstream read-model references to that
  column -- meaning nothing reads the staging table at all; only the
  explicit `/apply` route writes canonical rows). This is a static-code
  confirmation; no live staged-vs-approved dataset was queried this session.

**Verdict: PASS.** Registry, gate, and writer chain all independently
re-confirmed (not merely reused); zero dropped fields found in the three
hand-checked classes; staging isolation confirmed by code for all 8 classes.
No code change was needed for this section.

## 10. Mission section 7 -- manual/imported credit-card debt-service consistency

**One shared calculation, confirmed side-by-side, not two formulas.**
`lib/read-models/liabilities.ts`'s `computeLiabilities()` is the single
function both manual and imported liabilities run through (also mirrored,
independently, in the legacy `lib/engines/dashboard.ts:877-887` fallback path
with the identical PO-D-08 rule). For a REVOLVING facility (credit card,
line of credit, overdraft) with `rule='exclude_revolving'` (the default, PO
decision D-08): debt service = actual interest+fees when statement evidence
exists, else **0** -- keyed only on whether real ledger evidence exists
(`actual`), never on manual-vs-imported provenance. The existing oracle test
(`tests/unit/readModels/liabilityDebtServiceOracle.test.ts`) already puts a
manual card ($150 `monthly_repayment` -> 0) and an imported card (real
interest+fee -> 45, never the minimum payment) side by side under one
`describe` block titled exactly "PO D-08, applied equally to manual and
imported households" -- confirmed by reading the test, not just its name.
**Answer to the mission's core question: manual and imported cards are NOT
using different formulas.** The outcome differs only because a manual-only
card structurally never has `actual` populated (no facility ledger events
tie to it).

**A genuine, separate, code-level bug was found and FIXED this session** (not
a manual-vs-imported inconsistency, but a real R16 violation the mission's
"missing payment information must not silently become a genuine zero"
directly targets): `lib/validation/liability.ts:22` had
`monthly_repayment: z.number().min(0).default(0)` -- unlike `interest_rate`
and `minimum_payment` on the exact same schema (both correctly `.optional()`),
a manual liability saved with the repayment field left blank was persisted as
a genuine, indistinguishable `0`, not `null` ("not entered"). This defeats
even the existing, tested D-08 safety net for a zero-consumption household
(`householdDebtServiceUnderD08`, which restores a revolving card's
`contractualMonthly` when nothing else counts as consumption) and would
mislead any UI displaying the raw repayment figure. **Fixed**: changed to
`.optional()` (`lib/validation/liability.ts`, comment explains why), plus a
companion migration `0226_liabilities_monthly_repayment_no_default_zero.sql`
that drops the same `default 0` at the DB-column level
(`supabase/migrations/0003_module2.sql:50`) for defense-in-depth against any
insert path that bypasses the Zod layer. Neither change touches a single
existing stored value (`ALTER COLUMN ... DROP DEFAULT` only affects future
inserts; historical rows already showing `0` are a disclosed, separate
data-quality question, not silently rewritten -- consistent with mission
section 6's "existing manual values are not silently overwritten").
**Verified no regression**: `tests/unit/readModels/liabilityDebtServiceOracle.test.ts`,
`fdh10LiabilityCorrection.test.ts`, `fdh10LiabilityZeroAmountAtomicPersist.test.ts`,
and the three disposition-registry test files -- 102/102 pass. `tsc --noEmit`
across the full repo produced zero errors mentioning `liability` or
`monthly_repayment` (all pre-existing errors it does show are in the
unrelated `_integration_aie1_reconciled/` staging copy and unrelated scripts).

**Traced, not fixed -- a genuinely separate, disclosed coupling gap (SPD-15,
independently re-confirmed as plausible via a different exact mechanism than
originally labelled)**: on an ORDINARY (non-facility) bank account, an
imported `debt_interest` transaction (e.g. a personal loan's interest debited
straight from a checking account with no dedicated loan facility account
linked) is bucketed as ordinary spending (`lib/read-models/core/spendingRules.ts`
Rule 4) -- while that same loan's `monthly_repayment` is separately counted
in full as debt service via the `contractualMonthly` branch, since it has no
`actual` figures to replace it. The one existing de-duplication guard
(`isDuplicateDebtServiceExpense()`, `lib/engines/debtServiceContext.ts`) only
inspects PLANNED `expense_items` catalogue rows, never imported bank
transactions, and isn't wired into the canonical `selectExpenses`/
`spendingRules.ts` pipeline at all. No test currently constructs this exact
scenario, so it remains **traced, plausible, not proven live** -- carried
forward as SPD-15, not fixed this session (fixing a cross-read-model coupling
gap safely needs its own scoped pass, not a rushed addition here).

**Missing product decision, isolated (not guessed at), per SPD-01**: whether
a manual revolving card with no statement evidence should ever get an
ESTIMATED debt-service figure (the "agent's suggested estimated-interest
formula", `balance x rate / 12`, already exists verbatim for SMSF property
loans in `lib/engines/smsf/smsfPnl.ts:75-78` but is not applied to household
credit cards) -- and if so, precisely when, and what to do when APR itself is
also missing (no default-minimum-payment-percentage constant exists anywhere
in this codebase to fall back on). This is a real, currently-undocumented
product decision, not inferable from existing code or tests -- the same
"isolate, do not invent policy" discipline this closure programme already
applied to D-07/SPD-10 in part 2.

**Test coverage gaps identified** (not fixed this session): zero balance,
missing APR, explicit-zero vs. missing interest rate, promotional rates, and
mixed currencies are all untested for a revolving card's debt-service figure
specifically; `householdDebtServiceUnderD08`'s own safety-net branch has zero
test coverage despite having a named doc comment describing the exact
scenario it exists for.

**Verdict: PASS-with-disclosure.** The core mission-7 requirement (one
shared rule, not two formulas, applied identically to manual and imported) is
confirmed true, not merely asserted. One genuine, no-policy-needed bug found
and fixed (`monthly_repayment` 0-default). One coupling gap traced but not
proven live or fixed (SPD-15). One genuine product-policy gap correctly
isolated, not guessed at (SPD-01 estimate formula). Several test-coverage
gaps disclosed, not closed.

## 11. Mission section 11 -- AIE security controls

**Malware scan gate.** FDH-3 and Investment Intelligence's own admission
checks (`checkFdhDocumentMalwareAdmission`, `ensureIiRealScanAdmissible`) are
solid: only `clean` (or `not_required` while the kill switch is off) is ever
admitted, re-checked fresh at every processing entry point, with real
TOCTOU defenses (fresh S3 object key per attempt, eTag+versionId cross-check
against the caller's own expected values, admission-deadline enforcement).
The scan follow-up job makes a real, signed AWS `GetObjectTagging` call
against GuardDuty's own written tag (live-proven against a real DEV bucket on
2026-09-14 per existing code comments) -- not a stub. No mock-provider
fallback exists for malware scanning. IAM least-privilege is documented as a
5-role design (`docs/aie-programme/AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md`); the
actually-deployed credential's real IAM policy could not be confirmed from
code alone (needs live AWS access this environment does not have -- same
class of blocker as OPS-3).

**One real, currently-open gap found and FIXED this session**:
`aie_document_intake`'s INSERT policy (`with check (user_id = auth.uid())`,
migration 0140) has no column restriction, so an authenticated caller could
INSERT a brand-new row claiming `malware_scan_status: 'clean'` (or any other
value) from the very first write -- migration 0196 added exactly this
protection for the two sibling tables (`fdh_statement_uploads`,
`ii_source_documents`) but explicitly excluded `aie_document_intake`, and its
own stated reasoning ("the authenticated role already cannot update it") only
ever considered the UPDATE path, never INSERT. **Fixed**:
`supabase/migrations/0225_aie1_canonical_close_section11_intake_insert_forgery.sql`
extends 0196's own `aie_guard_malware_scan_verdict_columns()` trigger
(unmodified function body -- `CREATE OR REPLACE` is behaviour-preserving for
the two tables already wired) to `aie_document_intake` as a third
`BEFORE INSERT OR UPDATE` attachment. **PGlite-proven**
(`scripts/canonical_0225_pglite_verification.mjs`, 9/9 checks): the exact
forgery succeeds before 0225 and is refused (`42501`) after; a legitimate
insert matching the real application's `createIntake()` shape still succeeds
unchanged and lands with the honest server defaults; the server
(`service_role`) can still legitimately record a real verdict; 0196's own
guard on the two sibling tables is confirmed unaffected (regression check
included in the same script).

**This session's own correction to the sub-investigation's exploit
narrative** (independently checked, per constraint 8 -- do not just adopt the
stronger claim): the sub-investigation described a "storage_key reuse"
chain -- inserting a second row that points at another intake's real,
already-uploaded (possibly-malicious) bytes by copying its `storage_key`.
Independently reading `supabase/migrations/0140_aie1_1_shared_document_gateway.sql:96`
shows `storage_key text unique` -- a table-level UNIQUE constraint that
would make such a duplicate INSERT fail outright with `23505
unique_violation` while the original intake's key is still live (and once a
document reaches a terminal verdict, its key is cleared by the real purge
path, so there is nothing left to "reuse" after that either). The malware-
verdict-column forgery itself is real and independently confirmed (and is
what 0225 fixes); the specific "hijack another intake's real bytes via key
reuse" elaboration is narrower/likely not exploitable as originally
described. This is disclosed here rather than silently repeating the
stronger version.

**Cost-RPC controls, independently re-verified as already closed (migration
0195, already on `main`, not a gap this session needed to act on)**: PUBLIC/
default-privilege PostgREST access is explicitly revoked
(`revoke all on function ... from public, anon, authenticated`, granted only
to `service_role`); the sole application caller uses the service-role client
exclusively (repo-wide grep found zero client-reachable routes calling these
RPCs); idempotency-key replay cannot re-admit after settlement (`PRIMARY KEY`
+ `ON CONFLICT DO NOTHING`); concurrent reservation is serialized by a real
`SELECT ... FOR UPDATE` row lock, not an unlocked check-then-write; the
caller-supplied allowance can only ever LOWER the stored ceiling
(`least(...)`), sourced server-side only from an env var, never from a
request; settlement is idempotent (`already_settled` guard under the same row
lock); uncertain/timeout outcomes are billed at the FULL reserved amount
(`billing_uncertain=true`), never treated as a free retry; a stale-reservation
sweep (`aie_release_stale_ai_cost_reservations`) settles abandoned
reservations conservatively. One design note (not a defect): the cost ledger
is a single global row by explicit design (documented pilot-phase choice, not
per-tenant) -- a legitimate-use DoS vector on the shared pilot budget, already
disclosed in the migration's own header as a known future gap, not a coding
defect. One item **could not be determined from code alone**: whether
`aie_release_stale_ai_cost_reservations` is actually invoked by a scheduled
cron route in production (the function and its TS wrapper are correct; the
cron call site was not traced with certainty).

**Verdict: PASS-with-disclosure.** The one concrete, currently-exploitable
column-forgery gap this session found is fixed and PGlite-proven (not yet
applied -- see handoff). Cost-RPC controls are independently re-confirmed
already sound. Two items remain genuinely open and are disclosed, not
claimed closed: the actual deployed AWS IAM policy (needs live AWS access
this environment lacks) and whether the stale-reservation sweep is on an
actual production schedule.

## 12. Mission section 12 -- real GPT-4o mini and privacy proof

**Real evidence independently re-queried this session (not newly generated;
read-only against DEV with the service-role key, not a diagnostic/mock
call)**: `aie_ai_cost_attempt` on DEV (`vqycarelcoijzwlpkpcz`) holds multiple
real, successful `gpt-4o-mini` completions with genuine OpenAI request IDs
(e.g. `req_3b4ff454bfff4f0595ae2aba20d1d1d5`,
`req_11d02854d07c44abb94803c3b34de2b7`,
`req_66fab27027004cc2b55d25a79694de19`,
`req_b8b17f8984de437d9d0d7e4c9c14ff6b`), spanning bank-statement,
liability-statement, retirement-statement and AU-investment-statement AI
fallback, dated 2026-09-25/26, all `call_outcome='success'`,
`billing_uncertain=false`, with real, non-trivial input/output token counts
-- this is exactly the "real production application request requiring AI
fallback" the mission asks for, not a direct diagnostic API call (that would
be `scripts/aiecl_real_openai_provider_live_verify.mjs`, which this session
deliberately did NOT rely on as primary evidence for exactly the reason the
mission names it insufficient). **Attempted to trace one row
(`bank-statement-ai-fallback:367d9f79-...`) forward to its `fdh_statement_uploads`
row and canonical transactions**: the specific document had already been
cleaned up by the synthetic-manifest discipline the harness that generated it
uses (0 rows found) -- so a full intake-to-canonical trace for THIS specific
row could not be completed this session. The cost-ledger evidence itself
(retained deliberately, per mission section 18's "preserve necessary
non-sensitive audit and cost evidence") stands independently of that specific
document's lifecycle.

**Provider identity/config, confirmed by reading code** (not inferred from a
project dashboard this environment cannot reach): `store: false` is sent
explicitly on every request (`lib/aie/provider/openaiAieProvider.ts:199`);
the pinned model is `gpt-4o-mini` (`lib/aie/config.ts`, with a documented,
reasoned history of why the dated snapshot alias was rejected); provider
selection fails loud, never silently substitutes mock for real
(`providerFactory.ts` -- see mission section 11 above). **Explicitly NOT
claimed**: this session did not equate `store:false` with Zero Data
Retention, did not infer the OpenAI project/account identity or its
retention/data-sharing settings from source code (those require an OpenAI
account-level check this environment has no access to), and did not
determine residency/contractual conditions.

**Independent PII-absence check re-run this session**
(`scripts/aie1_masking_synthetic_pii_probe.ts`, 16 synthetic planted
identifiers -- names, AU TFN/mobile/landline/Medicare, IN PAN/Aadhaar/UAN,
BSB+account, addresses, DOB, email): **0 of 16 survive** `maskText`, checked
by plain substring containment (`maskedText.includes(plantedValue)`) -- an
independent method from the masking module's own regex, not "the same regex
checking itself" (the module's own `containsUnmaskedPii()` re-scan is
reported as a SEPARATE, secondary confirmation, not the primary pass/fail
signal). Money/date facts needed for extraction are preserved.

**Not done this session (budget)**: a fresh, full, single unbroken live
journey (real upload -> real masked egress captured in-flight -> real
provider request ID -> local schema validation -> reconciliation -> user
review -> canonical write) was not personally re-run end-to-end; this
session relied on independently re-querying real evidence a prior session's
`scripts/aie1_other_pdf_ai_live_dev_journeys.ts`/similar harnesses already
generated and left in the ledger, plus re-running the masking probe fresh.
Module 11 AI Coach's separate key/quota/premium-question policy was not
touched by anything this session did (no file under its path was read or
modified).

**Verdict: CONDITIONAL PASS.** Real `gpt-4o-mini` usage with genuine
provider request IDs is independently confirmed to exist in DEV, not
fabricated or merely asserted; `store:false` and fail-loud provider selection
are code-confirmed; PII absence is confirmed via an independent (non-regex)
method, freshly re-run this session. What remains open: a fresh single-trace
intake-to-canonical proof (the specific historical row had already been
cleaned up), and every OpenAI-account-level fact (ZDR, project identity,
residency/contract terms, finite spend enforcement beyond the DB-side cap
already verified in section 11) that requires access this environment does
not have.

## 13. Mission section 13 -- PDF deletion and durable review

**Storage layout, confirmed by reading code**: Supabase Storage quarantine
bucket (`aie-document-quarantine`) holds the bytes extraction actually reads;
a separate real AWS S3 bucket is used only for GuardDuty scanning (gated
fully off unless `AIE_REAL_MALWARE_SCAN_ENABLED=true`). No worker
local-disk-temp-file path exists anywhere in `lib/aie/**`.

**Deletion is synchronous on the primary path, confirmed by reading code**:
`finalizeDocumentBinaryAfterRun()` (`lib/aie/services/purge.ts`) runs
immediately after every extraction outcome (success, privacy-blocked,
unresolved, awaiting-acceptance) and after Investment-Intelligence/FDH-bank
accept-time re-download -- delete, then an INDEPENDENT list-based
`verifyQuarantineObjectAbsent()` (never trusts the delete call's own return
value), only then marks the row `purged`. A hard 24-hour backstop
(`enforceAieRawFileHardBackstop`) catches crashed/abandoned uploads
regardless of their stuck status. The S3 GuardDuty-copy purge distinguishes
`deleted` / `delete_marker_created` / `access_denied` / `unverifiable`
explicitly, never collapsing a denial into a false "gone".

**Real, live, independently-obtained production evidence this session (not
code review, not trusted from a prior doc)** -- this session queried
production (`twwpnltizhtjxhamyoxt`, read-only, service-role key from
`D:/FHIP/.env.local`, never printed) directly:
- `ii_source_documents` for the four real-user CAS PDFs a 2026-09-24
  production register had named as still-retained
  (`026369f4-b637-474b-b9b9-46bb418fc930`, `7dbe1b60-a5f0-4949-9e7a-d5ca58395513`,
  `85196a18-0c13-4a81-9474-2e9e16cd3cc9`, `91ec4378-6c89-408e-a9d0-f095676e3314`)
  all now show `storage_purged_at` set to **2026-09-25T01:45:0{0,1,1,2}.xxx UTC**
  with `storage_purge_error: null` -- matching this repo's own memory of "first
  real sweep 01:45 UTC purged all 5 retained II PDFs" exactly, independently
  re-confirmed here rather than taken on trust.
- A direct `GET /storage/v1/object/info/investment-source-documents/<path>`
  call against production for one of those four documents' actual
  `storage_path` returned **404 `NoSuchKey`** -- i.e. the underlying object
  is genuinely gone, not merely flagged gone in a DB column. This is the
  storage-level independent-absence proof mission section 13 explicitly
  requires ("absence is independently verified"), obtained live, this
  session, against production.
- The 5th canary object (an AWS S3 GuardDuty-bucket object, not Supabase
  Storage) could not be independently re-verified this session -- no AWS
  credentials are available in this environment (same class of blocker as
  OPS-3/section 11's IAM-policy gap).

**A genuine, disclosed gap in the repository's own migration history**
(distinct from the production behaviour above, which is fine): the pg_cron
scheduler migrations that are SUPPOSED to invoke the purge-sweep and
malware-scan-sweep cron routes on a schedule
(`0135_lr1_document_purge_sweep_scheduler.sql`,
`0149_aie1_closure_document_lifecycle_purge.sql`,
`0174_aie1_malware_scan_sweep_scheduler.sql`) still contain, in this
repository's own migration files, the literal placeholder string
`<REPLACE_WITH_REACHABLE_APP_ORIGIN>` (or `..._DEV_APP_ORIGIN>`) in their
`net.http_post` target URL -- and no follow-up migration in this repo's
history ever replaces it, unlike the NAV1/PC6 schedulers (0187, 0188, 0193,
0205, 0220, 0222), which DO hardcode the real production URL in a later
migration. Since the 2026-09-25 01:45 UTC sweep demonstrably DID run for
real in production (per the live evidence above), the practical conclusion
is that the real URL was patched directly into production's `cron.job` table
out-of-band (by a human operator, most likely via the Supabase SQL editor),
never captured back into a checked-in migration file. **This is a real,
disclosed drift risk** (this codebase's own established "migration IS the
history" discipline, per the migration-numbering/collision docs already in
this repo) -- if either database were ever rebuilt from migrations alone,
this placeholder bug would recur silently. **Not fixed this session**
(writing a migration that hardcodes production's exact cron `url`/secret
shape without being able to read the live `cron.job` row directly -- no
direct Postgres/psql access exists in this environment, only PostgREST --
risks guessing at the exact schema; flagged here as a named, actionable
follow-up rather than silently left off the register).

**Verdict: PASS-with-disclosure.** The core "PDF deleted, absence
independently verified" requirement is proven true, live, in production,
this session, for the 4 real-user documents named in a prior register as
still outstanding -- a genuine closure, not a re-assertion. One drift risk
(cron URL fixed live but never captured back into a migration) is disclosed
and named as a concrete follow-up. AWS-side canary-object verification
remains blocked on missing AWS credentials in this environment.

## 14. Mission section 14 -- II review and PC5

**II auto-apply protection**: consistent with section 9/6's finding that
Investment Intelligence's staging tables are never read by any downstream
consumer and canonical rows are written only by the explicit
`/investment-statement/[documentId]/apply` route after a user-initiated
review action -- reused, not independently re-tested fresh with a live
probe this session.

**PC5, read from the actual code this session (not from the prior
certification doc alone)**: `docs/investment-intelligence/PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md`
already certifies a real, built "PC5" -- Investment Intelligence's own
governed multi-source ownership/conflict-resolution workflow (migration
`0153_pc5_governed_resolution.sql`, present in this repo's migration
directory) -- as **CONDITIONAL PASS** (named blocker: 0153's own DEV
application status, not independently re-checked this session). That PC5 is
a real, separate, already-built feature for II's OWN data (K.1-K.22 test
items) -- it is not the same thing as "PC5 consuming AIE's unresolved
items."

**The specific mission-14 ask -- does PC5 actually consume AIE's
`aie_unresolved_item` queue -- is answered directly by the AIE-side code's
own header, read in full this session**:
`lib/aie/pc5/pc5ExceptionInterface.ts` states plainly, "**PC5 DOES NOT EXIST
IN THIS REPOSITORY** (confirmed by exhaustive search -- no table, route, or
module anywhere named or shaped like it [as a CALLER of this interface]; it
is a planned, unstarted roadmap phase) ... END-TO-END PC5 CLOSURE IS
EXPLICITLY BLOCKED -- there is no real PC5 caller to integrate with yet. Do
not read this module as 'PC5 integration complete.'" In other words: this
module is a tested, contract-shaped interface (`listOpenUnresolvedItemsForUser`
+ `decideOnItem`, no second exception store, no second status vocabulary --
correctly avoiding the mission's explicit "do not build a second exception
store" warning) that no real production caller has ever actually invoked.
**This is exactly the mission's own named risk** ("a tested interface with
no actual producer is not end-to-end integration") -- except inverted: here
it is a tested interface with **no actual CONSUMER**, which is the same
defect from the other side. This finding was not invented this session; it
was already candidly disclosed in the module's own header by whichever prior
session wrote it -- this session's contribution is independently reading and
carrying that disclosure forward into this register rather than letting it
sit undiscovered in a code comment.

**Not fixed this session**: building the real integration (wiring II's own
PC5 governed-resolution UI/routes to actually call
`pc5ExceptionInterface.ts`, including a genuine `checkCapability`
implementation) is a real, non-trivial feature addition, not a bug fix --
attempting it within this pass's remaining budget would risk exactly the
"rushed, second exception-store-like shortcut" the mission warns against.
Flagged as the concrete, named next step for section 14.

**Verdict: FAIL (as an end-to-end integration requirement), with the
individual AIE-side and PC5-side halves each independently sound.** Per the
mission's own instruction ("do not describe a deferred required item as
completed"), this is recorded as FAIL, not CONDITIONAL PASS -- there is no
real path today by which an AIE unresolved item reaches a PC5 user for
resolution; only a tested one-sided interface exists.

## 15. Mission section 16 -- deployment and production proof (this session's scope)

This environment cannot merge to `main`, apply any migration, or reach the
Amplify console/API (same standing OPS-3-class blocker recorded in prior
parts of this mission and in the G8 closure pass before it). What COULD be
done this session, and was:
- Confirmed `HEAD` == `origin/main` == `176bb61` at dispatch start (this
  branch is current, not stale).
- Confirmed the next free migration number is `0225` by scanning this
  repository's own `supabase/migrations/` AND every cached remote branch's
  migration tree via `git ls-tree` for any `0225`+ file -- none found, so
  `0225`/`0226` (this session's two new files) do not collide with any known
  branch.
- Confirmed, via direct production read-only REST calls (not merely
  asserted), that this environment DOES have production credentials
  available (in the main checkout's `D:/FHIP/.env.local`, not copied into
  this worktree's own `.env.local`) -- correcting an initial assumption that
  production testing would be fully blocked this session. This enabled the
  real section-13 production verification above.
- Did NOT attempt a fresh production timing sample for `GET
  /api/dashboard/summary` (part 2's own stated bonus item) -- that fix
  (`176bb61`) is already on `origin/main`/production per the SHA check above,
  but confirming Amplify's actual deployed build identity still needs the
  same blocked console/API access, and a timing sample without confirming
  deployment identity first would not be trustworthy evidence.

**Verdict: BLOCKED (unchanged from prior parts) for anything requiring
merge/migration-apply/Amplify access; NOT STARTED for a fresh full
implement-verify-merge-deploy cycle of this session's own two new migrations
(0225/0226) and one code fix (`lib/validation/liability.ts`).** See the
top-level handoff for the exact two-command push sequence and migration
apply instructions.

## 16. Synthetic-data discipline this session (mission section 18, partial)

No new synthetic test accounts, documents, or storage objects were created
this session. All evidence in sections 12 and 13 above was obtained by
READING existing DEV/production data (service-role SELECT/GET only) --
zero new residue to clean up from this session's own testing. The PGlite
verification scripts (0224-style, 0225 this session) run entirely in-memory
and leave no database residue by construction. This session's own git
worktree contains unrelated in-progress work from what appears to be a
different, concurrently-active session sharing this same worktree directory
(`lib/aie/adapters/investment-intelligence/householdContext.ts`,
`lib/investment-import-bridge/auAccountResolution.ts`,
`tests/unit/aieM3InvestmentDispatch.test.ts`,
`lib/services/household/`, `tests/unit/ensureSelfHouseholdMember.test.ts` --
none of these were touched, staged, or committed by this session; they
appeared in `git status` mid-session without this session editing them).
Flagged here so the PO knows this branch's commits deliberately exclude that
other work rather than silently absorbing or destroying it.
