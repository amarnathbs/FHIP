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
| **R20** | **System-owned provenance unforgeable** | **See detailed sub-rows below** | **This session: 2 new fixes, PGlite-proven; NOT yet applied to any DB** | **Apply migration 0224 to DEV then production; re-verify live; close the still-disclosed residuals** | Every provenance-bearing write is either system-derived or explicitly, verifiably manual | **CONDITIONAL PASS at code level, BLOCKED on migration application** (was FAIL; see below) |
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
| SPD-10 | D-07: unlinked bank income credits added as "other income" with a duplicate prompt; split deposits/bonus months evade it | NOT STARTED (mission section 10 target: "split-deposit income detection") |
| SPD-11 | GP-O1: manual grids allow only one catalogue row per item type | NOT STARTED |
| SPD-12 | GP-O3: expense-averages proposal cannot target a subcategory the review page can't pick (rent/housing never proposed) | NOT STARTED |
| SPD-13 | Combined-basis group displacement (a group's actuals replace its whole plan) -- confirm or blend | NOT STARTED |
| SPD-14 | Dashboard summary timing: 23-39s vs 28s Amplify limit; 110 DB round trips, ~70 from unnecessary 100-id chunking | NOT STARTED (mission section 9 target) |
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
| 9 | Dashboard performance | NOT STARTED this session (SPD-14 open, root cause already identified in the reused report) |
| 10 | Remaining integration defects (cash withdrawal, split deposit, etc.) | NOT STARTED this session |
| 11 | AIE security controls (malware/cost RPC) | NOT STARTED this session |
| 12 | Real GPT-4o mini + privacy proof | NOT STARTED this session |
| 13 | PDF deletion + durable review proof | NOT STARTED this session |
| 14 | II review + PC5 | NOT STARTED this session |
| 15 | Accessibility + released scope | NOT STARTED this session |
| 16 | Deployment + production proof | NOT STARTED this session (0224 not yet handed to a deploy step beyond this branch) |
| 17 | Production test matrix | NOT STARTED this session |
| 18 | Observation/cleanup/rollback | NOT STARTED this session |
| 19 | Final certification | This document + the top-level handoff report are the interim version; NOT a final certification (R30 NOT RUN, sections 6-18 NOT STARTED) |

## 5. Operator-blocked items (OPS-)

| ID | Item | Why blocked |
|---|---|---|
| OPS-1 | Independently re-confirm 0218 is applied and enforcing on DEV | This session's environment has DEV read (service-role) access but did not re-run a live forgery/refusal probe against 0218's specific triggers this pass; the 2026-09-27 report's own claim ("0218 is not yet applied on DEV") was not re-checked |
| OPS-2 | Apply migration 0224 to DEV, then production | This environment cannot execute DDL against either database (standing constraint). File delivered; see handoff |
| OPS-3 | Confirm the actual deployed production SHA/build identity | No Amplify console/API access in this environment (same blocker as prior sessions) |
| OPS-4 | Live-DEV/production re-proof of R20-A/R20-B after 0224 is applied | Requires OPS-2 first |

## 6. Session status (honest, per the mission's own anti-rounding-up instruction)

**What this session actually did:**
1. Re-verified the mission's reported baseline against the real repository and
   DEV state, found and recorded the drift (section 0 above).
2. Built this closure register, reconciling the reported 30-item arithmetic
   and carrying forward all ~16 smaller open items without narrowing scope.
3. Independently reviewed (not re-proved from scratch) the PO's Score/Twin
   decision and found it internally consistent -- did not discard or
   re-litigate it.
4. Fixed, at the code level, BOTH of R20's re-confirmed residual provenance
   gaps (migration `0224_aie1_canonical_close_r20_provenance_gaps.sql`),
   with a real anti-vacuity PGlite proof (12/12) showing each exploit
   succeeding before the fix and refused after, and every legitimate path
   still working.

**What this session explicitly did NOT do** (mission sections 6-19, and R30):
field-to-canonical traceability mapping, the credit-card consistency shared
rule, dashboard performance fix, the remaining integration defects (cash
withdrawal/split deposit/retirement UNKNOWN/etc.), AIE security-control
verification, real GPT-4o mini/privacy proof, PDF-deletion proof, PC5/II
review completion, accessibility verification, actual deployment of ANY
change (0224 sits on branch `aie1-canonical-closure-20260928`, not merged,
not applied to any database), the full production test matrix, observation/
rollback readiness, or a final certification. None of these are claimed done.

**Exact next action needed from the PO:**
1. Review migration `0224_aie1_canonical_close_r20_provenance_gaps.sql` and,
   if acceptable, apply it to DEV first, then production (this environment
   cannot run DDL).
2. Merge branch `aie1-canonical-closure-20260928` to `main` (see the top-level
   handoff message for the exact two-command sequence, since this environment
   cannot push to `main` directly).
3. Decide whether a further session should continue with mission sections
   6-19 (a large amount of work remains) or whether the PO wants to
   re-prioritize a subset first.
