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
| 4 | Binding architecture preserved | Respected: 0224 adds no second parser/writer/calc source; explicitly reasoned about and rejected a SQL re-derivation of the WP-15 average for exactly this reason (see 0224's own header) |
| 5 | Source-provenance vulnerabilities | **WORKED THIS SESSION** -- R20-A/R20-B above; both fixed at the code level, PGlite-proven, NOT deployed |
| 6 | Field-to-canonical traceability | NOT STARTED this session (reused R1/R25 evidence only) |
| 7 | Manual/imported credit-card consistency | NOT STARTED this session (R6/R7 evidence reused as-is; SPD-01/05 open) |
| 8 | Score/Twin equivalence | Reviewed, not re-proven from scratch -- see section 2 |
| 9 | Dashboard performance | **WORKED AND LIVE-PROVEN this session** -- see section 5 below. Root cause re-derived independently (not trusted from the prior note), fixed, and proven live on DEV at both n=300 and the report's own n=1,000 scale: 108 -> 44 round trips, 17.8s -> ~5.7-5.8s warm, financial output byte-identical before/after. Not yet merged/deployed |
| 10 | Remaining integration defects (cash withdrawal, split deposit, etc.) | **PARTIALLY WORKED this session** -- see section 6 below |
| 11 | AIE security controls (malware/cost RPC) | NOT STARTED this session |
| 12 | Real GPT-4o mini + privacy proof | NOT STARTED this session |
| 13 | PDF deletion + durable review proof | NOT STARTED this session |
| 14 | II review + PC5 | NOT STARTED this session |
| 15 | Accessibility + released scope | NOT STARTED this session |
| 16 | Deployment + production proof | NOT STARTED this session (0224 not yet handed to a deploy step beyond this branch) |
| 17 | Production test matrix | NOT STARTED this session |
| 18 | Observation/cleanup/rollback | NOT STARTED this session |
| 19 | Final certification | This document + the top-level handoff report are the interim version; NOT a final certification (R30 NOT RUN, sections 6-18 NOT STARTED) |

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
