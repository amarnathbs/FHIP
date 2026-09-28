# Approved Upload -> Canonical User Data -- Final Completion Report

Date: 2026-09-27 (updated after the Stage 3 FINAL live-DEV proof pass). Consolidated branch:
`feature/canonical-upload-cert` up to `285ac01`, plus a further verified merge pushed as
`stage3-final-merge` at `6fffc27` -- **not yet folded back into `feature/canonical-upload-cert` or `main`**;
that is a one-line fast-forward the PO can do, or ask for.
Companion reports: END_TO_END_IMPORT_PROPAGATION_CERTIFICATION.md, MANUAL_VS_IMPORTED_EQUIVALENCE_CERTIFICATION.md,
PRODUCTION_IMPORT_PROPAGATION_CERTIFICATION.md (plan), CANONICAL_EXPENSE_DATA_CONTRACT.md,
APPROVED_UPLOAD_TO_CANONICAL_DATA_CONTRACT.md, APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md,
UPLOAD_FIELD_DISPOSITION_REGISTRY.md, DOWNSTREAM_DATA_CONSUMER_MATRIX.md.

## Headline

- **DEV: NOT a full pass.** Of the 30 brief requirements below, 21 are PASS, 7 are PASS-with-disclosure,
  **1 is FAIL** (R20, system-owned provenance unforgeable: two residual forging paths on the user's OWN
  data, both waiting for a PO decision, and RE-CONFIRMED live and still open on the truly final merged
  tree -- see "Stage 3 FINAL live-proof pass" below), and 1 is NOT RUN (R30, production).
- **One genuine production-code defect found and fixed** in the final pass, unrelated to any of the above:
  every retirement-statement audit event (account/payslip/bank matching) has been silently failing its
  database write since FDH-12 shipped, in every environment including production, because of a wrong id.
  Fixed with a proven negative-control test; independently re-verified by me (not just the building agent).
- **One narrow, well-understood gap in the golden-pair result**, found on re-run after the merge: the
  Score and Twin numbers diverge slightly between a manually-entered household and an imports-only one with
  identical economics, traced to a fixture-data artifact (a stale historical row only an approved import
  corrects), not to any canonical financial figure. Every actual dollar figure -- income, expenses, assets,
  liabilities, investments, retirement, net worth, cashflow, and all 6 forecast types -- is still exactly $0
  different. This needs a PO framing decision (see below), not more debugging.
- **Production: NOT CERTIFIED.** Nothing has been deployed or applied in production. The PO-run plan is ready,
  with 4 blockers to clear first (PRODUCTION_IMPORT_PROPAGATION_CERTIFICATION.md section 0), the first being
  the Dashboard summary's response time against the 28 s platform limit -- re-measured in the final pass at
  18.3 s wall-clock this run, but the underlying database round-trip count (110) is unchanged from the
  29.6 s run that DID breach the limit, so this remains open, not closed.

## Stage 3 FINAL live-proof pass (new, 2026-09-27, after this report was first written)

Four further live-DEV dispatches ran against the fully-merged `feature/canonical-upload-cert @ 285ac01`
(every migration through 0218 confirmed present and enforcing on DEV), followed by a consolidation I did
myself after the automated consolidator agent could not stand up its DEV harness (no credentials in its
isolated worktree) and stopped without doing any work. I merged the four branches by hand, resolved the one
conflict (two independently-written residue SQL files for the same path), and independently re-verified
every claim below myself rather than taking each agent's own report on trust:

- **Re-verified myself:** `tsc --noEmit` 0 errors on the fully merged tree; `eslint --max-warnings 0` clean on
  every one of the 4 real changed files; the retirement fix's own regression test (`fdh12RetirementHistory.test.ts`,
  77 tests total in that run) passes on the fix and -- checked by literally reverting just the one file and
  re-running -- **fails by exactly the claimed 2 assertions on the pre-fix code**, confirming the negative
  control is real, not asserted.
- **True concurrency, live, on real overlapping HTTP calls (not PGlite, which cannot do this):** card
  liability, loan liability, income (payslip), retirement, and both WP-15 proposal types each fired as two
  genuinely-overlapping Apply requests (overlap proven by timestamp, not sequencing) -- every single case
  produced exactly one success and one safe rejection, zero double-writes, zero crashes, confirmed by direct
  database row counts.
- **WP-15 full lifecycle, live:** generate -> user edits the underlying data -> apply refused
  (`409 STALE_PROPOSAL`, all-or-nothing) -> regenerate -> apply -> re-apply refused
  (`409 ALREADY_APPLIED`) -> a superseded proposal is refused, and a post-apply regenerate reports
  "already applied" rather than silently reapplying with old numbers.
- **A real defect found and fixed:** three retirement-statement audit-event call sites passed the
  statement's own database id instead of its uploaded-document id, so every insert into the audit-event
  table violated its foreign key and was silently dropped (a caught `console.error`, not a thrown error) --
  in every environment, including production, for every retirement statement FDH-12 has ever processed.
  Fixed in `lib/financial-data-hub/services/retirementStatementProcessingService.ts` and
  `lib/retirement-import-bridge/retirementAccountResolution.ts`.
- **The Australian investment journey, live, end to end:** upload -> approve -> Apply -> "Imported, not yet
  in Net Worth" ($5,000 held back) -> Add to Net Worth -> Net Worth and the Investments tab both update
  (+$5,000) on the next request.
- **The retirement journey, live:** 8 fields offered for confirmation, only the ticked ones applied; full
  evidence history visible on the Retirement tab; the bank-leg confirmation step correctly refuses to
  override a category the user had already chosen by hand (documented precedence, not a bug).
- **0218's four security fixes, RE-ATTEMPTED live against a DEV database that actually has 0218 applied**
  (the security certifier had only proven these in PGlite and against a pre-0218 DEV): all four -- a forged
  liability statement, a cross-tenant split line, a currency-mismatched asset, and anon execution of the
  WP-15 functions -- are refused, with the exact error text 0218's own migration predicted.
- **The manual-vs-imported comparison, re-run live end to end on the final merged branch** (the earlier
  post-merge check only spot-verified two rules, not the full comparison): every core financial figure --
  income, expenses (every basis), assets, liabilities including debt service, investments, retirement, net
  worth, cashflow (surplus, savings rate, DSR, DTI, emergency fund), every register row, all 6 forecast
  types, and the report's net worth section -- is exactly $0 different between the two households. **Score
  and Twin are the one exception**: they diverge by a small amount (45.521 vs 46.244; "23 behind" vs "22
  behind") because the Score engine's cash-flow-stability component reads a fixture user's pre-existing
  historical month, and only an approved statement import retroactively corrects that stale historical row
  -- manual entry never touches history. This is a test-fixture artifact interacting with a real, intentional
  product behaviour (approved imports correcting history; manual entry does not), not a defect in any
  canonical financial figure. **PO decision needed:** is this asymmetry acceptable as designed, or should
  manual entry also get a way to correct historical months?
- **R20's two open provenance gaps, DELIBERATELY RE-ATTEMPTED live on the final branch to quantify them
  precisely** (not to fix them -- that is the PO's decision, recorded below): a hand-crafted expense
  proposal for $999,999.99/month, labelled as coming from real bank statements with none behind it, was
  successfully applied; and an ordinary, unprocessed bank-CSV upload was successfully repurposed into a
  fabricated $499,999.99 loan-payoff statement via a direct database call. Both remain confirmed possible
  on the truly final branch. Concrete remediation is now specified for both (see the open-decisions table).
- **Timing, re-measured on the final branch:** 18.3 s wall-clock this run (vs. the certifier's own 29.6 s on
  identical code) at the same 110 database round trips -- the round-trip count, which is what actually
  determines whether this breaches the 28 s limit under load, is unchanged. Root cause traced precisely:
  about 70 of the 110 round trips are 100-id chunked reads of tables that are already filtered to the
  current user, which do not need to be chunked by id at all. A concrete fix is specified (below) but not
  implemented, since this pass was scoping-only as instructed.
- **Residue:** 42 rows total across the four dispatches, all the same known pattern (an applied card/loan
  chain the service role cannot remove because of 0218's own guards). Combined into one guarded,
  transaction-safe file with real row-count assertions -- see below.

## Verdict per brief requirement

Legend: PASS = proven live on DEV (or by the named gate) with no reservation; PASS-with-disclosure = proven,
with a stated limit that does not falsify the requirement; FAIL = the requirement is not met; NOT RUN.

| # | Requirement (brief) | Verdict | Evidence |
|---|---|---|---|
| R1 | Every approved fact ends in exactly one of A-E; silently dropped = 0 | PASS | field-disposition registry: 893 entries, 0 open gaps in all 9 files; `STRICT_CERTIFICATION` now ON; gate 36/36; anti-vacuity proves an orphan / re-opened P0 gap fails the gate |
| R2 | One fact -> one canonical economic effect; no duplicate canonical truth | PASS | economic oracles (card 220, loan, payslip x bank both orders, super, broker, rollover) live on DEV; golden pair $0 unexplained |
| R3 | Payslip: every field disposed; current != current + YTD; payslip + bank salary = one income event; employer super never income | PASS-with-disclosure | econ `scenario_payslip.ts` (both orders), `scenario_retirement.ts`; disclosure: D-07 (unlinked bank income credits added as "other income" with a duplicate prompt) -- a split deposit or bonus month evades the prompt (open PO decision) |
| R4 | Bank: every transaction type has a canonical destination | PASS | registry R9 (every economic type -> read-model bucket); rule 10 (money in of a spending type = refund) |
| R5 | Expenses: planned (expense_items) vs actual (approved fdh_transactions); one read model; each consumer chooses its basis; Expenses tab shows imported actuals | PASS-with-disclosure | SUI U1 screenshot; golden pair; CANONICAL_EXPENSE_DATA_CONTRACT.md. Disclosure: on the COMBINED basis a group's actuals replace that group's whole plan -- live on DEV (merged tree, forecast.tc025) two uncategorised card purchases (220, group "other") replaced 16,875/month of planned "other", Dashboard surplus -9,505 -> +7,150 (open PO decision "combined-basis group displacement") |
| R6 | Credit card: purchases 200 + 20, repayment 220 -> expense 220, never 440; cash advance not consumption; balance updated | PASS | econ (both filing choices, concurrency); consolidation live recheck on the merged tree 13/13 |
| R7 | Loan: 2,000 = 1,550 principal + 430 interest + 20 fee; outflow once; drawdown not income | PASS-with-disclosure | econ `scenario_loan.ts`. Disclosure: an UNSPLIT loan PAYMENT is recorded as a transfer (open PO decision) |
| R8 | Liability Apply atomic; repeat Apply creates nothing | PASS | econ true concurrency (two connections) -> 1 x 200 + 1 x ALREADY_APPLIED; D2 older-statement guard fixed |
| R9 | AU investments -> Investment Intelligence; BUY / SELL / dividend oracles; holdings visible | PASS | econ `scenario_broker.ts`; R9 fixed (live +400 not +15,400) and re-proven on the merged tree (forecast.tc034, 4/4); SUI-3 == GP-D1 (Add to Net Worth) and SUI-4 (grid) fixed; re-proven again live end-to-end (upload -> Apply -> "not yet in Net Worth" -> Add to Net Worth -> Net Worth + Investments tab both update) in the Stage 3 FINAL pass |
| R10 | India documents route to the India II engine (no shadow engine) | PASS-with-disclosure | unchanged by this programme (stage-2 WP-12 design; CAS path untouched); not re-exercised live in stage 3 |
| R11 | Retirement: summary register; evidence user-visible; super one effect; rollover neutral; SMSF stays SMSF-owned | PASS | econ `scenario_retirement.ts`; SUI U4 + SUI-5 (confirmed account target) fixed; ret-* screenshots |
| R12 | Insurance / other AIE uploads: included only if a real flow reaches Apply | PASS | registry: 21 insurance entries `not_active` ("ACTIVE USER FLOW: NO"), never certified |
| R13 | Input tabs show manual + imported rows with a provenance label | PASS | SUI U1-U5 screenshots (badges + history links); SUI-4 grid fix |
| R14 | One read model per financial meaning shared by every consumer | PASS | golden pair: Dashboard, Score, DNA, Resilience, Twin, Forecast (6), Report all agree M == I |
| R15 | Before Apply effect 0; after Apply immediately | PASS | GP-1 / GP-2; consolidation live (before the card Apply only the user-filed bank line counted) |
| R16 | Error != 0; null != 0 | PASS-with-disclosure | DB-1 fixed (unreadable sections never stored or scored as 0); disclosures: GP-8 live injected read failure not run (unit-tested); GAP-09 null net no longer falls back to gross per row (open PO decision) |
| R17 | Currency preserved; AUD and INR never added | PASS | GP-6; SR-03 (bank-balance asset currency) fixed in 0218 |
| R18 | Self != spouse | PASS | GP-7 |
| R19 | Cross-tenant 0 | PASS-with-disclosure | security: 12 cross-tenant RPC calls refused; SR-02 (cross-tenant split lines, pre-existing since 0047) fixed in 0218 -- **0218 is not yet applied on DEV** (`po_run/DEV_apply_0218.sql`) |
| R20 | System-owned provenance unforgeable | **FAIL** | (a) WP-15 expense proposals are user-inserted and not re-derived: live, a 999,999.99/month planned expense labelled "from your actual spending" with no statement behind it was applied (security S4); (b) `fdh10_persist_liability_statement` is SECURITY INVOKER: a user can still call it with any numbers for their own document (SR-01 residual). Both are the user's own data only; closing them is a PO decision (service-role generator / server-side derivation; persist to the service role). 0218 closed the direct-INSERT forging path (SR-01) and every other provenance write the review tried was refused. **RE-CONFIRMED still open in the Stage 3 FINAL pass**, deliberately re-attempted live on the truly final merged branch (a $999,999.99 forged expense and a $499,999.99 forged loan-payoff statement both succeeded), to quantify -- not to fix -- exactly what remains forgeable before the PO decides |
| R21 | Stale / repeated / concurrent Apply safe | PASS | econ (card/loan, income, retirement, WP-15 on two connections); security (5 concurrent -> 1 write) |
| R22 | Duplicate / overlapping uploads -> 0 duplicate effects | PASS | SUI S3: byte-identical and re-exported 1,000/1,001-line statements -> 0 new rows, 0 change |
| R23 | User corrections / splits propagate | PASS | econ `scenario_split_correction.ts` |
| R24 | UNKNOWN never silently categorised | PASS | econ `scenario_unknown.ts` |
| R25 | Field-disposition registry in code + CI test; an orphan field fails certification | PASS | as R1; STRICT on |
| R26 | Golden pair: $0 unexplained variance across all consumers | PASS-with-disclosure | MANUAL_VS_IMPORTED_EQUIVALENCE_CERTIFICATION.md; measured on the golden-pair branch before the merge; **the full M/I pair was re-run live end-to-end on the truly final merged branch in the Stage 3 FINAL pass** (superseding the earlier "not re-run" note): every dollar figure across income/expenses/assets/liabilities/investments/retirement/net worth/cashflow/all 6 forecasts/report net worth is exactly $0 different. Disclosure: Score and Twin diverge slightly (45.521 vs 46.244; 23 vs 22 "behind"), root-caused to a fixture-history back-fill asymmetry (see the Stage 3 FINAL section above). **PO DECISION (2026-09-28): accepted as designed, not a defect** -- a household that has provided real historical evidence (approved imports correcting a past month) legitimately gets a more informed Cash-Flow-Stability score than one that has only asserted today's numbers; the measured gap was inflated by stale fixture-only test data, not a real same-user inconsistency. No product code change. Follow-up: harness fix only (below) |
| R27 | Scale: 1,000 / 1,001 lines no truncation; same statement twice -> 0 duplicates | PASS | SUI S1-S3 (every layer, every total) |
| R28 | Discoverability: Expenses -> Import Bank Statement; Retirement -> Import Statement | PASS | SUI U9; fdh14 e2e 6/6 against DEV |
| R29 | The nine programme documents | PASS | all nine under `docs/financial-data-hub/` |
| R30 | Production certification | NOT RUN | PRODUCTION_IMPORT_PROPAGATION_CERTIFICATION.md (plan) |

Count: **PASS 21** (R1, R2, R4, R6, R8, R9, R11-R15, R17, R18, R21-R25, R27-R29), **PASS-with-disclosure 7**
(R3, R5, R7, R10, R16, R19, R26), **FAIL 1** (R20), **NOT RUN 1** (R30). R27 covers truncation and duplicates
only; the 28 s response-time risk is not a brief requirement row and is listed as deploy blocker 1.

## Deploy blockers (must be cleared before production)

1. `GET /api/dashboard/summary`: 23-39 s on localhost against DEV (~110 Supabase round trips) vs the 28 s
   Amplify limit. Re-measured in the Stage 3 FINAL pass at 18.3 s wall-clock / still 110 round trips -- the
   round-trip count is what actually determines the risk under load, and it is unchanged, so this is NOT
   closed. Root cause now precisely identified: ~70 of the 110 round trips are 100-id-chunked reads, in
   `lib/read-models/core/ledger.ts` and `lib/read-models/corroboration.ts`, of `fdh_transaction_links` (both
   directions), `fdh_transaction_allocations`, `fdh_transaction_corrections` and 4 corroboration-evidence
   tables -- every one of which is already filtered to the current user, so chunking by transaction id is
   not load-bearing there. Recommended fix (not implemented, scoping only): replace each with a single
   per-user read and intersect against the known transaction-id set client-side; estimated to remove
   60-70 of the ~110 round trips at 1,000 transactions.
   (Other heavy routes after SUI-1: categorise 7.4 s, remember payee 13.3 s, approve-all 18.9 s,
   expenses/actuals 17-25 s on localhost.)
2. Migrations 0207-0214 and 0218 must be applied in ONE sitting immediately before the code goes live
   (code-first breaks card/loan/retirement/AU uploads; migrations-first with old code silently double counts
   card/loan spending (0209) and can write $0 holding snapshots (0213)). 0218 must first be applied on DEV.
3. The release PR must merge current `main` (6 NAV1-only commits; clean per `git merge-tree`).
4. PO decisions below that change user-visible figures -- at minimum the combined-basis group displacement.

## Open PO decisions (listed, not decided)

| Id | Decision needed |
|---|---|
| D-08 | Manual revolving cards contribute $0 debt service (agent suggestion was estimated interest = balance x rate / 12) |
| GAP-09 | A null net pay no longer falls back to gross per row -- confirm |
| Pension | pension PAYMENT -> income, pension WITHDRAWAL -> transfer -- confirm |
| Premium report | the investment chapter reports itself unavailable when the FX rate cannot be read -- confirm |
| Loan | an UNSPLIT loan PAYMENT is recorded as a transfer -- confirm |
| Rule 10 (SUI-2) | on an ordinary account a credit of a spending type is a refund (nets only with a confirmed refund link, D-01) -- confirm the semantics |
| WP-15 forge | expense-average proposals are user-inserted and not re-derived (999,999.99 forge proven live, RE-CONFIRMED on the final merged branch): either re-derive the average server-side inside the apply RPC from real approved transactions, or move proposal generation entirely to a service-role path and refuse authenticated inserts to `fhip_import_proposals`/`fhip_import_proposal_fields` for these domains |
| SR-01 residual | `fdh10_persist_liability_statement` is SECURITY INVOKER and accepts ANY queued document as if it were a liability statement (RE-CONFIRMED live: an ordinary bank-CSV upload was turned into a fabricated $499,999.99 loan payoff on the final branch): move it to a service-role path that itself re-derives the statement from the actual parsed document, or checks `document_type` before accepting it |
| ~~Score/Twin fixture asymmetry~~ | **RESOLVED (PO, 2026-09-28): accepted as designed.** An imports-only household legitimately gets a more informed Cash-Flow-Stability score than a manual-only one when it has provided real historical evidence a manual entry never asserts -- this mirrors the existing null/error != 0 principle (R16), not a new inconsistency. No manual-entry historical-correction feature will be built for this reason. The measured 0.7-point gap in the certification run was inflated by stale fixture-era `financial_snapshots` data left over from an earlier test run, not a genuine same-user divergence -- follow-up: add a `financial_snapshots` reset step to the certification harness's `neutralise.mjs` (tracked separately, test-infrastructure only, no product code) |
| D-07 | income combination: unlinked bank income credits are added as "other income" with a duplicate prompt; split deposits / bonus months evade the prompt |
| GP-O1 | manual grids allow one catalogue row per item type (no second groceries line in another currency, no second share holding) |
| GP-O3 | the expense-averages proposal asks for a subcategory the review page cannot pick, so rent / housing are never proposed |
| Combined basis | a group's actuals replace that group's whole plan on the combined basis (live: 16,875/month planned "other" replaced by 220 of uncategorised card purchases) -- confirm, or blend / require coverage per category |
| Timing | Dashboard summary 23-39 s vs 28 s (deploy blocker 1): measure or cut round trips before release |
| Suspected P3 | `debt_interest` on an ORDINARY bank account counted as spending while the contractual repayment also counts (security review; not proven live) |
| Per-country Net Worth | per-country Net Worth sums differ from Net Worth by the investments total (golden pair; not investigated) |
| Fixture snapshots | 7 synthetic fixture `financial_snapshots` rows (Aug 2026) carry certification-run cash-flow values (originals not captured): leave, or null their cash-flow columns |

## What the consolidation did (this dispatch)

- Merged the four certifier branches into `feature/canonical-upload-cert` (security `8d1a688`, economic oracles
  `6d6b6d4`, scale/UI `927e0a5`, golden pair `1870fe8`), keeping ONE implementation where the same defect was
  fixed more than once (SUI-3 == GP-D1; D3 == SUI-6 == GP-D5; SUI-9 == the security time-bomb fix) and
  reconciling the three edits to `effectiveBucket` precedence (D1, R9, rule 10) -- see END_TO_END report.
- Fixed 2 merge-level defects (`cb6fe2e`), added the combined precedence test (negative controls: reverting
  D1 / R9 / rule 10 fails 5 / 3 / 6 of 9), turned `STRICT_CERTIFICATION` on.
- Verified the merged tree: tsc 0; eslint clean on changed files (3 pre-existing `any`s in the fdh14 e2e spec,
  same on main); full vitest 20 failed / 9,575 passed / 43 skipped -- every failed test identical on
  origin/main in isolation, 3 failed suites explained (2 need a worktree `.env.local`, 1 flaky live-DEV test
  passing 25/25 in isolation on both); PGlite 12 scripts 537 checks 0 FAIL; disposition gate 36/36.
- Re-ran on DEV what the merge could change: merged precedence 13/13 and R9 4/4 (range A).
- PO files: `scripts/canonical_cert/dev_residue_ALL_for_PO.sql` (115 rows, guarded, proven on the real migration
  chain, checked read-only against DEV), `docs/financial-data-hub/po_run/DEV_apply_0218.sql` (guarded, proven),
  `docs/financial-data-hub/po_run/PRODUCTION_preflight_READ_ONLY.sql`.

## Residue on DEV (after the PO runs both residue files: zero rows, except item 3)

1. 115 guarded rows (applied card/loan chains, GP-H1) + 2 fixture rows to restore -> `dev_residue_ALL_for_PO.sql`
   (from the first stage-3 consolidation).
2. A further 42 guarded rows from the Stage 3 FINAL pass (18 from the concurrency dispatch, forecast.tc012;
   24 from the golden-pair re-run, forecast.tc048 + the abandoned forecast.tc025 attempt) -> combined into
   `dev_residue_FINAL_for_PO.sql`, with real row-count assertions per section (the two dispatches' own files
   only had comments, not assertions, so I rebuilt them properly before merging).
3. 7 synthetic fixture `financial_snapshots` rows with certification-run cash-flow values (see the table above).
4. Unavoidable: `auth.users.last_sign_in_at` and GoTrue audit entries for the signed-in fixture users.

## What the Stage 3 FINAL consolidation did (this update, after the automated consolidator agent blocked)

- The dispatched consolidator agent stopped immediately: its isolated worktree had no DEV credentials and no
  `node_modules`, and copying either from another worktree was refused by its own sandbox as a hard isolation
  boundary. It did no merge, ran no tests, wrote nothing. I did the consolidation myself instead.
- Pushed the two live-proof branches that had not yet reached `origin` (`feature/canonical-cert-final-au-retirement-0218-live`,
  `feature/canonical-cert-final-timing-and-r20-scope`) so nothing was lost.
- Merged all four live-proof branches into `feature/canonical-upload-cert @ 285ac01` with zero git conflicts
  except the two residue SQL files sharing one path, which I combined properly (see above). Only one of the
  four branches (`concurrency-wp15`) contained a real production-code change; the other three are
  verification-only (harness scripts, evidence files, a scoped Playwright config).
- Independently re-verified, myself, not from the agents' own claims: `tsc --noEmit` 0 errors on the fully
  merged tree; `eslint --max-warnings 0` clean on all 4 real changed files; the retirement fix's regression
  test (77 tests across the 3 related suites) passes on the fix, and I proved the negative control myself by
  reverting just that one file and re-running -- it fails by exactly the 2 claimed assertions.
- Pushed the result as `stage3-final-merge` (not yet folded back into `feature/canonical-upload-cert` or
  `main` -- a one-line fast-forward, on request).
