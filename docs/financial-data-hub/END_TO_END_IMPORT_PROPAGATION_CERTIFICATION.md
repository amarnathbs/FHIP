# End-to-End Import Propagation Certification

Approved Upload -> Canonical User Data programme, stage 3 (certification on DEV). Date: 2026-09-27.
Consolidated branch: `feature/canonical-upload-cert`. Environment: DEV `vqycarelcoijzwlpkpcz` only, through
the app running on localhost; existing synthetic fixture users only (ranges A-D, `scripts/canonical_cert/USER_RANGES.json`).
Production was not accessed in any way.

## Verdict

**DEV: propagation PASS with fixes and disclosures; the programme as a whole is NOT a full pass** -- one
brief requirement (R20, system-owned provenance unforgeable) is FAIL pending a PO decision, see
FINAL_COMPLETION_REPORT.md. Every approved fact from every ACTIVE upload flow (payslip, bank
statement, credit card, loan, AU broker, super/retirement) was followed from upload -> review -> approve /
Apply -> canonical state or event -> every downstream consumer, live on DEV through the real routes. The
four certifiers made 26 fixes (22 distinct defects once the same defect fixed by two or three certifiers is
counted once; 2 of the 22 are test/harness-only: the expired test date and the harness session revoke), each
with a test that fails before the fix. All are merged into the consolidated branch and re-verified there,
plus 2 merge-level defects the consolidation found and fixed. Items that do NOT pass are listed under
"Not passing / open" and in FINAL_COMPLETION_REPORT.md; none of them is hidden inside a PASS row.

**Production: NOT CERTIFIED.** The PO runs the plan in PRODUCTION_IMPORT_PROPAGATION_CERTIFICATION.md.

## Who certified what

| Certifier (range) | Branch @ head | Scope | Result |
|---|---|---|---|
| Economic oracles + Apply safety (B) | `feature/canonical-cert-economic-oracles` @ `6d6b6d4` | card, loan, payslip x bank (both orders), employer super, broker BUY/SELL/dividend, rollover, WP-15, true concurrency, cross-tenant, UNKNOWN, splits | 22 checks: 19 PASS, 3 FIXED |
| Scale + UI journeys (C) | `feature/canonical-cert-scale-and-ui` @ `927e0a5` | 1000/1001-line statements, re-upload, timings, every input tab badge/history, disclosure panel, D-13, discoverability, category-totals review, fdh14 e2e | PASS_WITH_FIXES (10 defects fixed) |
| Adversarial security / integrity review (D) | `feature/canonical-cert-security-review` @ `8d1a688` | GUC bypass, 45 DEFINER functions, provenance forging, WP-15 forging, races, CHECK widenings, read models, deploy order | PASS_WITH_FIXES (migration 0218 + R9 + DB-1) |
| Golden pair M vs I (A) | `feature/canonical-cert-golden-pair` @ `1870fe8` | $0 unexplained variance across all consumers | PASS_WITH_FIXES (GP-D1..D6), see MANUAL_VS_IMPORTED_EQUIVALENCE_CERTIFICATION.md |
| Consolidation (A) | `feature/canonical-upload-cert` | merge of the four, re-verification, live rechecks of what the merge could change | this document |

## Propagation evidence per flow (live DEV, through the real routes, as the user)

| Flow | Oracle | Evidence | Result |
|---|---|---|---|
| Credit card | purchases 200 + 20, bank repayment 220 -> household spending **220, never 440**; repayment = confirmed `credit_card_settlement` link; liability = statement closing | econ `scenario_card.ts` (repayment filed as Credit-Card Payment AND as Shopping); consolidation `consol/recheck_precedence_live.ts` on the MERGED tree: spending +220, 1 confirmed link, liability +1,000 | PASS (D1 fixed: a confirmed link now beats user_override) |
| Card cash advance / interest | cash advance 300 -> "Cash - spending unknown", not consumption; interest 12 -> cost of debt | econ `scenario_card.ts` | PASS |
| Older card statement | an older statement never regresses a newer applied balance / due date | econ `recheck_older_statement.ts`, `tests/unit/liabilityOlderStatementGuard.test.ts` | FIXED (D2) |
| Loan | payment 2,000 = principal 1,550 (liability -1,550) + interest 430 + fee 20 (cost of debt 450); outflow 2,000 once; drawdown not income | econ `scenario_loan.ts` | PASS |
| Payslip x bank salary | payslip 5,000 net + bank salary 5,000 -> income 5,000 in BOTH orders (WP-09 restamp) | econ `scenario_payslip.ts` | PASS |
| Employer super | on payslip + fund statement -> one effect, never income | econ `scenario_retirement.ts` | PASS |
| Retirement rollover | fund A -> fund B: income 0, expense 0, Net Worth 0 | econ `scenario_retirement.ts` | PASS |
| Retirement Apply target | the proposal applies to the account the user CONFIRMED | SUI-5, `tests/unit/fdh12ConfirmedAccountTarget.test.ts`, screenshots ret-04..09 | FIXED |
| AU broker | bank->broker 10k + BUY -> expense 0; SELL 15k -> ordinary income 0; dividend broker 400 + bank 400 -> one 400 | econ `scenario_broker.ts`; security `scenario_sell_override.ts`; consolidation R9 recheck on the MERGED tree (forecast.tc034): SELL filed as Income before approval -> income +400 only | PASS (R9 fixed: later approved evidence beats an earlier user choice) |
| AU Add to Net Worth | "Imported, not yet in Net Worth" -> Add -> Investments tab and Dashboard agree | SUI-3 == GP-D1 (uuid correlation id), SUI-4 (grid kept one row per master key) | FIXED |
| Bank statement actuals | Woolworths 200 shows on the Expenses tab next to planned, with the provenance badge | SUI U1 (exp-03 screenshot), GP | PASS |
| Money in of a spending type | a credit filed as Food is an UNLINKED refund: never added to spending, nets only with a confirmed refund link (D-01) | SUI-2 / rule 10 (1,000-line statement: 413,100 not 459,505); consolidation live: +20 unlinked, 0 netted, spending unchanged | FIXED |
| Statement period | a complete prior month counts | GP-D3 (panels never sent the period -> $0) | FIXED |
| Bank-first then card | repayment approved before the card statement still links | GP-D2 | FIXED |
| Apply-written card/loan lines | categorised, description shown | GP-D4 | FIXED |
| Bank balance (D-04) | proposed as a cash asset the user applies; once applied, never disclosed as "not in Net Worth" | econ D3 == SUI-6 == GP-D5 -> one rule; GP-D6 (asset country) | FIXED |
| WP-15 expense averages | generate / apply / re-apply / stale | econ `scenario_wp15.ts` | PASS (forging exposure: see "Not passing / open") |
| Scale | 1,000 and 1,001 lines: no truncation at file / parse / DB / review / approval / actuals / Dashboard; same statement twice (byte-identical and re-exported) -> 0 new rows, 0 change to any total | SUI `scale_journey.ts`, `test-artifacts/canonical_cert/scale-*.json` | PASS |
| Timings | every request under the 28 s Amplify limit | categorise 293 s -> 7.4 s, remember payee 410 s -> 13.3 s after SUI-1; **GET /api/dashboard/summary 23-39 s on localhost (~110 Supabase calls)** | NOT PROVEN for production (deploy blocker, see FINAL_COMPLETION_REPORT.md) |
| Before / after Apply | before Apply effect 0; after Apply on the next request | GP-1, GP-2; consolidation live (before the card Apply only the user-filed bank line counted) | PASS |
| Currency | AUD and INR never added raw | GP-6; SR-03 (bank-balance asset currency) fixed in 0218 | PASS (0218 must be applied) |
| Owner | self vs spouse kept | GP-7 | PASS |
| Repeat / concurrent Apply | exactly one effect | econ (two simultaneous Applies on separate connections for card/loan, income, retirement, WP-15 -> 1 x 200 + 1 x ALREADY_APPLIED); security (5 concurrent -> 1 write) | PASS |
| Cross-tenant | refused | security: 12 cross-tenant RPC calls refused; SR-02 (split lines on another user's transaction, pre-existing since 0047) fixed in 0218 | PASS (0218 must be applied) |
| UNKNOWN | never silently categorised | econ `scenario_unknown.ts` | PASS |
| Corrections / splits | propagate | econ `scenario_split_correction.ts` | PASS |
| Error != 0 | an unreadable section is never stored or scored as 0 | DB-1 fixed (`tests/unit/secrevDashboardFailClosed.test.ts`); no live injected failure (GP-8 not run) | PASS with disclosure |
| UI | badges + history links on Income / Expenses / Liabilities / Retirement / Assets; disclosure panel; D-13 redirect; Expenses -> Import bank statement; Retirement -> Import statement; category-totals review | SUI U1-U10 screenshots under `test-artifacts/canonical_cert/`; `tests/e2e/fdh14-ui-accessibility-smoke.spec.ts` 6/6 against DEV | PASS |

## Consolidation (this dispatch)

### Merges into `feature/canonical-upload-cert` (base `b7a4a2e`)

| Branch | Conflicts | Resolution |
|---|---|---|
| security-review `8d1a688` | none | merged as is (0218, R9, DB-1, time-bomb) |
| economic-oracles `6d6b6d4` | none (git) | D1 and R9 combined cleanly: the user_override gate moved after the link checks (D1); R9 clears user_override in the ledger |
| scale-and-ui `927e0a5` | spendingRules.ts, ledger.ts, reportCanonicalAppendix.ts, dashboardCanonicalAdapter.ts, reportSnapshotResolver.ts, fdhBankApprovalIntegrity.test.ts | effectiveBucket: rule 10 shapes the BASE bucket, confirmed links (D1) run before the user_override gate, R9 decided in the ledger; ledger passes the R9-adjusted override AND creditDebit; disclosure: consumers keep econ's one helper; the time-bomb: one relative future timestamp (SUI-9 == security) |
| golden-pair `1870fe8` | publishAuPositions.ts, assets.ts, reportCanonicalAppendix.ts, dashboardCanonicalAdapter.ts, reportSnapshotResolver.ts | GP-D1 == SUI-3 (one uuid correlation id); GP-D5 == SUI-6 == D3 (one rule) |

Merge-level defects found only on the merged tree, fixed in `cb6fe2e`:
1. Two incompatible implementations of the bank-balance disclosure (the helper summed accounts itself; the model computed open-only totals; two source-scan tests each required their own). Now the model computes the open-only total / count ONCE and `bankBalancesNotInNetWorth()` only turns it into a disclosure; both certifiers' tests pass, plus a behavioural test through the helper.
2. `statementResumeListAndApplyOnce` got HTTP 500 from the liability proposal route: econ D2's `loadAppliedAsOfByLiability` uses `.not(col,'is',null)`, which the in-memory Supabase fake lacked. Added to the fake.

Combined precedence test (new): `tests/unit/readModels/effectiveBucketPrecedence.test.ts` -- one household
exercising D1 + R9 + rule 10 together (spending 370; transfer 440; invested 10,000; one unlinked refund of 20),
each control flipping exactly one fix. Negative controls run during consolidation: reverting D1 fails 5/9,
reverting R9 fails 3/9, reverting rule 10 fails 6/9.

Registry: `STRICT_CERTIFICATION` turned ON (every one of the 9 registry files has OPEN_GAP_CEILING 0 and strict
mode finds nothing; the anti-vacuity control proves R7 fires on a re-opened P0 gap). 893 entries, doc current.

### Verification on the merged tree

| Gate | Result |
|---|---|
| tsc --noEmit | 0 errors |
| eslint on every changed file | 0 problems, except 3 `no-explicit-any` errors in `tests/e2e/fdh14-ui-accessibility-smoke.spec.ts` (the same 3 `any`s exist on origin/main, at lines 31/35/51 there and 31/35/66 here) |
| Full vitest | **20 failed / 9,575 passed / 43 skipped (9,638 tests); 7 of 535 files failed.** Every failed TEST is identical on origin/main `d7e0ae7` run in isolation (adminAnalyticsPhaseAMeRoute 17, aiResidualClosureFailClosed A4 1, countryGateAccessMatrix MC-15 1, resourcesR1_1 5 s timeout 1). The 3 failed SUITES: resourcesImportR1_7LiveDev and resourcesP0ContentR1_7CLiveDev need a worktree `.env.local` (same on main); resourcesDiscoveryR1_6LiveDev failed once under parallel load and passes 25/25 in isolation on BOTH main and this branch (a live-DEV Resources test that reads `D:/FHIP/.env.local` directly; its own cleanup left 0 rows). The first full run on the merged tree had 2 more failures caused by the merge (both fixed above). `git checkout -- scripts/` run after each suite. |
| PGlite (12 scripts) | all exit 0, **537 checks, 0 FAIL**: 0199 14, 0200 39, 0201 8, 0207 63, 0208 41, 0209 36, 0210 71, 0211 79, 0212 47, 0213 46, 0214 59, 0218 34 |
| New PGlite tests | `canonicalCertResidueAllSql.test.ts` 7/7 (the PO residue SQL on the real chain, 5 negative controls); `canonicalCertDevApply0218.test.ts` 5/5 (3 negative controls) |
| Disposition gate | 36/36 with STRICT on; doc check current (893 entries) |
| Golden-pair variance tooling | offline on the merged tree: M vs I PASS (0 unexplained); injected control FAIL naming 3 headline + 2 leaf variances |

### Live rechecks on DEV (merged code, localhost 127.0.0.1:3981, range A)

| Recheck | User | Result | Residue |
|---|---|---|---|
| Merged precedence: repayment filed Shopping + card Apply; 20 credit filed Food | forecast.tc025 | **13/13**: spending +220 (never 440); 1 confirmed settlement link; +20 unlinked refund, 0 netted; liability +1,000; Net Worth -1,000; Dashboard expenses delta == expense read model delta; not-applied bank balance disclosed | the applied card chain (6 rows), in the PO file |
| R9 on the merged tree | forecast.tc034 | **4/4**: SELL 15,000 filed as Income before the broker approval -> income +400 only | 0 (verify ok over 158 tables) |

Live finding during the recheck (not a merge regression; the economic-oracle certifier's open item, now
quantified): the COMBINED expense basis replaces a planned GROUP by that group's actuals. The fixture's whole
plan sits in group "other" (16,875/month); after the card Apply two uncategorised card purchases (220, group
"other") replaced it, so combined expenses fell 17,095 -> 220 and the Dashboard surplus went -9,505 -> +7,150.
Listed as an open PO decision.

## Not passing / open (repeated in FINAL_COMPLETION_REPORT.md)

- WP-15 expense proposals are user-inserted and not re-derived server-side: a 999,999.99/month planned expense
  labelled "from your actual spending" with no statement behind it was applied live (security S4 = FAIL).
- `fdh10_persist_liability_statement` is SECURITY INVOKER: a user can still call it directly with any numbers
  for their own document (SR-01 residual).
- Dashboard summary 23-39 s on localhost vs the 28 s Amplify limit (deploy blocker until measured/cut).
- 0218 is not applied on DEV (the PO file below).

## Residue on DEV

1. **115 rows the service role cannot delete** (applied card/loan chains, GP-H1), all owned by synthetic
   fixture users: range A golden pair 48 (forecast.tc010), range B 48 (5 fixture users), range C 8 + 2 fixture
   rows to restore (fhip.e2e.tc001), range D 5 (forecast.tc004), consolidation 6 (forecast.tc025).
   One guarded file: `scripts/canonical_cert/dev_residue_ALL_for_PO.sql` (generated by
   `build_dev_residue_all_sql.mjs` from the four certifier files + the consolidation run). It refuses unless
   `ii_nav_retention_policy` has a `dev` row and no `production` row, pre-checks that every row exists and is
   synthetic-owned, runs in one transaction and asserts every UPDATE/DELETE count. Proven on the real
   migration chain (`tests/unit/canonicalCertResidueAllSql.test.ts`) and checked read-only against DEV
   (`check_dev_residue_all.mjs`: guard passes, 115/115 rows present, 0 dependents).
2. **7 fixture `financial_snapshots` rows (month 2026-08) carry certification-run cash-flow values.** The
   Dashboard back-fills the cash-flow columns of every COVERED month's existing snapshot row; the residue ledger
   does not snapshot rows the app updates in tables without `updated_at`, so the originals were not captured:
   forecast.tc003, tc008, tc013, fhip.e2e.tc001 (range C), forecast.tc025, tc034 (consolidation), and
   forecast.tc004 (range D, cash-flow + FX columns set to null by the security certifier). Net worth, assets and
   liabilities columns are untouched. These are derived-cache rows of synthetic users; they cannot be restored
   exactly. PO choice: leave them, or null their cash-flow columns. (Harness gap: snapshot `financial_snapshots`
   rows before a run.)
3. Unavoidable, not reachable through PostgREST: `auth.users.last_sign_in_at` and GoTrue audit-log entries for
   the users signed in.
4. A certifier dev server was left running on 127.0.0.1:3971 (the golden-pair certifier could not stop it); the
   consolidation stopped its own server on 3981.
