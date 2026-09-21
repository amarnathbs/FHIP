# LR Production Traceability Matrix

## 2026-09-21 ADDENDUM

Rows re-classified below reflect direct 2026-09-21 source/migration inspection (not a relabelling of 09-14 prose). All other rows in §A–§K are unchanged from 09-14 and were not independently re-verified this pass.

| ID | 09-14 | 09-21 update |
|---|---|---|
| FI-02 Net Worth = Gross Assets − Liabilities | REGRESSED AFTER PRIOR CERTIFICATION (P0-1) | **Fixed for the reported scenario** (`ea95507`); superseding commit `368d98f` discloses a narrower, still-open correlation question (fund-level netting) explicitly flagged to the PO. Reclassify: **DEFERRED — EXPLICIT PO AUTHORIZATION EXISTS** for the residual question (not "regressed," not a clean pass) |
| FI-07 SMSF liabilities not double-subtracted | REGRESSED (P0-1) | Same reclassification as FI-02 — same underlying fix |
| S-03 Detailed valuation / holdings maintenance | REGRESSED (P0-2, `42501`) | **Fixed** — migration `0148` restores the dropped guard bracket, confirmed on `origin/main`. Reclassify: **IMPLEMENTED — MAIN ONLY** pending a fresh live-DEV re-run (this pass's toolchain could not execute the oracle; see Cannot-Verify register) |
| S-05 Holdings gross minus canonical liabilities | REGRESSED (P0-1) | Same reclassification as FI-02 |
| U-09 Purge covers every document-capable path | PARTIALLY IMPLEMENTED (P1-3, `ii_source_documents` had no purge at all) | **Upgraded to PARTIALLY IMPLEMENTED, going-forward only** — migration `0161` (2026-09-19) wires a real, independently-traced purge call (`documentProcessing.ts:1201`); pre-`0161` documents remain unpurged. The *gate/malware* half of P1-3 (the other reason this row was marked partial) is untouched — see the new row below |
| *(new)* U-11 FDH-3 production upload gate state | not applicable at 09-14 (gate was correctly OFF) | **NEW FINDING**: gate deliberately opened in production 2026-09-20 (commit `c4891185`, explicit PO decision) while the malware-scanning prerequisite (§13.1) remains unmet system-wide. Classification: **SECURITY-GATED — INTENTIONALLY DISABLED PENDING PREREQUISITES does not apply (the gate is now open, not disabled)**; the correct Section-5 classification is **IMPLEMENTED DIFFERENTLY — EXPLICIT PO AUTHORIZATION EXISTS**, carrying a live, disclosed operational risk (no scanning) rather than a defect in the gate mechanism itself | **P1** (operational-risk severity, not a code defect) |
| P-01 / P-02 / P-05 Payments configuration | APPLICATION CODE DEPLOYED — CONFIGURATION MISSING (P1-2) | **Unchanged, now precisely re-confirmed**: exact missing vars (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`), exact fail-closed behavior confirmed symmetric for both providers (`stripeClient.ts:31-48`, `razorpayClient.ts:18-35`), route-level confirmation both checkout and both webhooks fail closed correctly. New, smaller finding: `checkout/route.ts`'s error responses leak the raw `NOT_CONFIGURED`/`KEY_ENVIRONMENT_MISMATCH` code to the end user instead of an honest sentence (P2, see the master addendum) |

**§L Migration reconciliation — rows to add** (0140–0164 were absent from main at 09-14 baseline `ff35f54`; see `LR_2026_09_21_RECONCILIATION_ADDENDUM.md` §0b for the full 27-migration reconciliation):

| Migration | On main | DEV applied | PROD applied | Drift |
|---|---|---|---|---|
| `0148` LR P0-2 fix (`smsf_recompute_fund` guard bracket) | Y | Not re-probed this pass (toolchain blocked) | **Cannot verify — production credentials withheld from this pass** | Fixes `0137`'s regression |
| `0154` HUF entity type (India-only, PO-authorized 2026-09-15) | Y | Not re-probed this pass | Migration's own header states **NONE** as of 2026-09-15 — not re-confirmed as still true on 2026-09-21 | Not an LR requirement |
| `0161` II source-document purge tracking | Y | Not re-probed this pass | **Cannot verify — production credentials withheld** | Partially closes P1-3's retention half |

**§M Cleanup** — this pass's own synthetic DEV users (4 total, across `z01`/`z02`) were deleted at the end of each script run, confirmed in script output (`cleanup: deleted N synthetic DEV users`). No production writes were made or attempted this pass; production credentials were not available to this session.

---

**Date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54`
One row per atomic requirement (Section 4). Classification values are the 19 allowed by Section 5.

**Column key** — Main: is the implementation on canonical `origin/main`? DevDB / ProdDB: required schema present? Depl: present in the deployed production artifact? UI: reachable through intended navigation? LiveDEV / LiveProd: exercised end-to-end today? Fin: financially correct where applicable? Sec: secure / tenant-isolated where applicable? Ops: operational readiness proven where required?

`—` = not applicable. `?` = could not verify; see the Final Report §6.

---

## A. Global financial invariants (§7)

| ID | Requirement | Main | DevDB | ProdDB | Depl | UI | LiveDEV | LiveProd | Fin | Sec | Ops | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FI-01 | Gross Assets = personal + investments + retirement + ownership-scaled entity value, once | Y | Y | Y | Y | Y | **Y** | ? | **Y** | — | — | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| FI-02 | Net Worth = Gross Assets − Liabilities | Y | Y | Y | Y | Y | **Y** | ? | **N** | — | — | **REGRESSED AFTER PRIOR CERTIFICATION** | **P0-1** |
| FI-03 | Goals do not add to Net Worth | Y | Y | Y | Y | Y | Y | ? | Y | — | — | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| FI-04 | Insurance cover does not add to Net Worth | Y | Y | Y | Y | Y | Y | ? | Y | — | — | as above | — |
| FI-05 | Future contributions do not add to current Net Worth | Y | Y | Y | Y | Y | **Y** | ? | Y | — | — | as above | — |
| FI-06 | SMSF member balances non-additive | Y | Y | Y | Y | Y | Y | ? | Y | — | — | as above | — |
| FI-07 | **SMSF liabilities not double-subtracted** | Y | Y | Y | Y | Y | **Y (FAIL)** | — | **N** | — | — | **REGRESSED AFTER PRIOR CERTIFICATION** | **P0-1** |
| FI-08 | Company/Trust assets not added on top of ownership NAV | Y | Y | Y | Y | Y | **Y** | — | Y | — | — | IMPLEMENTED — PRODUCTION CERTIFIED (structural) | — |
| FI-09 | Imported evidence does not duplicate canonical balances | Y | Y | Y | Y | Y | — | — | Y | — | — | IMPLEMENTED — MAIN ONLY (unreachable, see IM-01) | — |
| FI-10 | Legacy Company/Trust owner tags cannot double-count | Y | Y | Y | Y | Partial | **Y (FAIL)** | — | **N** | — | — | PARTIALLY IMPLEMENTED | P2-5 |
| FI-11 | Personal cash flow excludes SMSF operating flows | Y | Y | Y | Y | Y | **Y** | ? | **Y** | — | — | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| FI-12 | Personal cash flow excludes entity operating flows | Y | — | — | Y | Y | **Y** | — | Y (structural) | — | — | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| FI-13 | **DSR oracle = 10%, not 30%** | Y | Y | Y | Y | Y | **Y PASS** | ? | **Y** | — | — | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| FI-14 | DTI excludes SMSF balances | Y | Y | Y | Y | Y | **Y PASS** | ? | Y | — | — | as above | — |
| FI-15 | SMSF property link establishes SMSF debt context automatically | Y | Y | Y | Y | Y | **Y PASS** | ? | Y | — | — | as above | — |
| FI-16 | Direct `owner='smsf'` still works where no link exists | Y | Y | Y | Y | Y | **Y PASS** | ? | Y | — | — | as above | — |
| FI-17 | Entity liabilities never in personal DTI/DSR | Y | Y | Y | Y | Y | **Y PASS** | — | Y | — | — | IMPLEMENTED — PRODUCTION CERTIFIED (structural) | — |
| FI-18 | No personal guarantee inferred | Y | — | — | Y | — | Y | — | Y | — | — | IMPLEMENTED — MAIN ONLY | — |
| FI-19 | Net Worth byte-identical when only cash-flow context changes | Y | Y | Y | Y | Y | **Y PASS** | — | Y | — | — | as FI-13 | — |
| FI-20 | Loan payment = principal + interest + fees; principal is outflow not expense | Y | Y | Y | Y | Y | Y | ? | Y | — | — | as FI-13 | — |
| FI-21 | Credit-card repayments do not duplicate classified purchases | Y | Y | Y | Y | Y | Y | — | Y | — | — | as FI-13 | — |
| FI-22 | No fuzzy matching anywhere in debt classification | Y | Y | Y | Y | — | Y | — | Y | — | — | IMPLEMENTED — MAIN ONLY | — |
| FI-23 | **One dollar enters projected wealth once** | Y | Y | Y | Y | Y | **Y PASS 8/8** | ? | **Y** | — | — | as FI-13 | — |
| FI-24 | Employer contribution remains external additive cash | Y | Y | Y | Y | Y | **Y PASS** | ? | Y | — | — | as FI-13 | — |
| FI-25 | SMSF contributions do not contaminate personal contribution forecasting | Y | Y | Y | Y | Y | **Y (FAIL)** | — | **N** | — | — | PARTIALLY IMPLEMENTED | P2-3 |
| FI-26 | Goal `manualCurrentAmount` and live linked funding stay distinct | Y | Y | Y | Y | Y | Y | ? | Y | — | — | as FI-13 | — |
| FI-27 | Goal forecast/variance/detail share one basis | Y | Y | Y | Y | Y | Y | ? | Y | — | — | as FI-13 | — |
| FI-28 | Net Worth breakdown reconciles with the total shown beside it | Y | Y | Y | Y | Y | **Y (FAIL)** | — | **N** | — | — | PARTIALLY IMPLEMENTED | P2-4 |

---

## B. Cross-module consistency

| ID | Requirement | Main | DevDB | ProdDB | Depl | UI | LiveDEV | Fin | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|---|
| XM-01 | Health Score / DNA / Resilience / Recommendations consume the canonical engine | Y | Y | Y | Y | Y | Y | Y | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| XM-02 | **Financial Twin shows the same household figures as the Dashboard** | Y | Y | Y | Y | Y | **Y (FAIL)** | **N** | **PARTIALLY IMPLEMENTED** | **P1-4** |
| XM-03 | Reports consume the canonical engine | Y | Y | Y | Y | Y | Partial | Partial | PARTIALLY IMPLEMENTED | P2 |
| XM-04 | AI context consumes the canonical engine | Y | Y | Y | Y | Y | — | Partial | PARTIALLY IMPLEMENTED | P3 |
| XM-05 | Forecast net-worth branch uses whole-balance-sheet amortisation | Y | Y | Y | Y | Y | Y | Y | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |

---

## C. LR-1 — Upload security and raw-file deletion

| ID | Requirement | Main | DevDB | ProdDB | Depl | LiveDEV | LiveProd | Sec | Ops | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|
| U-01 | Strict raw-file deletion, no evidence vault (FDH) | Y | Y | Y | Y | Y | — | Y | Y | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| U-02 | 50-minute hard backstop | Y | Y | Y | Y | Y | — | Y | **Design only, never measured** | OPERATIONALLY NOT READY | P2 |
| U-03 | 5-minute sweep cadence, exactly one scheduler | Y | Y | Y | Y | Y | ? | Y | ? | CANNOT VERIFY (pg_cron not introspectable via REST) | P3 |
| U-04 | Janitor executes autonomously, correct environment, vault secret | Y | Y | Y | Y | Y | **Y — 200 + correct sweep JSON today** | Y | Y | **IMPLEMENTED — PRODUCTION CERTIFIED** | — |
| U-05 | Raw object deletion verified absent before marking purged | Y | Y | Y | Y | Y | — | Y | Y | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| U-06 | No retained base64 / blob / full extracted text | Y | — | — | Y | Y | — | Y | — | as above | — |
| U-07 | Cross-user storage denial | Y | Y | Y | Y | **Y** | — | **Y** | — | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| U-08 | No public bucket | Y | Y | Y | Y | Y | **Y** | Y | — | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| U-09 | **Purge covers every document-capable path** | **N** | — | — | — | — | — | **N** | — | **PARTIALLY IMPLEMENTED** — `ii_source_documents` has no purge at all | **P1-3** |
| U-10 | `fdh-source-documents` bucket exists in production | Y | Y | **N** | — | — | — | — | — | **APPLICATION CODE DEPLOYED — DATABASE MISSING** | **P1-9** |

---

## D. LR-2 — Unified manual input UX

| ID | Requirement | Main | Depl | UI | LiveDEV | Classification | Sev |
|---|---|---|---|---|---|---|---|
| M-01..08 | Form-first pattern on Income, Expenses, Assets, Liabilities, Investments, Retirement, Insurance, Goals | Y | Y | Y | Y | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | — |
| M-09 | No blank editable legacy grid rows | Y | Y | Y | Y | as above | — |
| M-10 | No autosave-on-keystroke | Y | Y | Y | Y | as above | — |
| M-11 | Edit reloads the row into the form; `owner` preserved | Y | Y | Y | Y | as above | — |
| M-12 | No double annualisation | Y | Y | Y | Y | as above | — |
| M-13 | Investments partial-index upsert fix remains effective | Y | Y | Y | Y | **IMPLEMENTED — verified intact** | — |
| M-14 | Blank-optional-field edit-after-reload fix remains effective | Y | Y | Y | Y | **IMPLEMENTED — verified intact** | — |
| M-15 | No duplicate row on edit | Y | Y | Y | Partial | **PARTIALLY IMPLEMENTED** — II-published investments duplicate | P2-10 |
| M-16 | Insurance `cover_type` collected or inferred | **N** | Y | **N** | **Y (FAIL)** | **NEVER IMPLEMENTED** | **P2-2** |
| M-17 | Clearing an optional text/date field persists | **N** | Y | Y | — | PARTIALLY IMPLEMENTED | P3 |

---

## E. LR-3 / LR-4 — Import

| ID | Requirement | Main | DevDB | ProdDB | Depl | UI | LiveDEV | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|
| IM-01 | **Expenses: Upload → Analyse → Review → Accept → Apply** | Partial | Y | Y | Y | Y | **N — dead-ends at `queued`** | **BACKEND EXISTS — NO USER ENTRY POINT** | **P1-7** |
| IM-02 | Approved bank transactions reach household calculations exactly once | Y | Y | Y | Y | Y | Y (at the data layer) | IMPLEMENTED — MAIN ONLY (unreachable via UI) | — |
| IM-03 | Staged data cannot affect calculations before approval | Y | Y | Y | Y | — | Y | IMPLEMENTED — DEPLOYED | — |
| IM-04 | `superseded_by_bank_import` prevents double counting | Y | Y | Y | Y | Y | Y | IMPLEMENTED — DEPLOYED | — |
| IM-05 | Payslip → canonical `income_sources` | Y | Y | Y | Y | Y | — | SECURITY-GATED — INTENTIONALLY DISABLED | — |
| IM-06 | Liability statement → canonical `liabilities` | Y | Y | Y | Y | Y | — | SECURITY-GATED | — |
| IM-07 | Liability import extracts monthly interest and fees to canonical | **N** | — | — | — | — | — | PARTIALLY IMPLEMENTED (evidence only) | P3 |
| IM-08 | Liability PDF import | **N** | — | — | — | — | — | **NEVER IMPLEMENTED** | P2 |
| IM-09 | Retirement statement → canonical `retirement_accounts` | Y | Y | Y | Y | Y | — | SECURITY-GATED | — |
| IM-10 | Retirement PDF import | **N** | — | — | — | — | — | **NEVER IMPLEMENTED** (refused in code) | P2 |
| IM-11 | AU broker import journey | **N** | — | — | — | — | — | **NEVER IMPLEMENTED** — all named brokers documented UNSUPPORTED | P2 |
| IM-12 | AU investment statement → canonical `investments` without a second manual step | **N** | — | — | — | — | — | **IMPLEMENTED DIFFERENTLY — NO PO AUTHORIZATION FOUND** | P2 |
| IM-13 | India CAS → canonical `investments` | Y | Y | Y | Y | Y | **Live in production** | **IMPLEMENTED — PRODUCTION CERTIFIED for function; UNGATED for security** | **P1-3** |
| IM-14 | Insurance document import | **N** | — | — | — | — | — | **NEVER IMPLEMENTED** | P2 |
| IM-15 | SMSF / entity document import | **N** | — | — | — | — | — | **NEVER IMPLEMENTED** | P2 |

---

## F. LR-5 / LR-6 — SMSF

| ID | Requirement | Main | DevDB | ProdDB | Depl | UI | LiveDEV | Fin | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|---|
| S-01 | AU-only SMSF workspace under Retirement | Y | Y | Y | Y | Y | Y | — | IMPLEMENTED — DEPLOYED | — |
| S-02 | Fund profile, members, Summary valuation | Y | Y | Y | Y | Y | Y | Y | as above | — |
| S-03 | **Detailed valuation / holdings maintenance** | Y | Y | Y | Y | Y | **N — 42501** | — | **REGRESSED AFTER PRIOR CERTIFICATION** | **P0-2** |
| S-04 | Summary XOR Detailed, $0-variance gate | Y | Y | Y | Y | Y | **Y PASS** | Y | IMPLEMENTED — DEPLOYED | — |
| S-05 | Holdings gross minus canonical liabilities | Y | Y | Y | Y | Y | Y | **N** | **REGRESSED** | **P0-1** |
| S-06 | SMSF household isolation | Y | Y | Y | Y | Y | **Y PASS** | Y | IMPLEMENTED — DEPLOYED | — |
| S-07 | SMSF value in Net Worth, excluded from DTI/DSR | Y | Y | Y | Y | Y | **Y PASS** | Y | IMPLEMENTED — DEPLOYED | — |
| S-08 | SMSF P&L | Y | Y | Y | Y | Y | — | ? | CANNOT VERIFY (no production fixture) | P3 |
| S-09 | FY period selection genuinely filters historical data | ? | — | — | — | — | — | ? | **CANNOT VERIFY** — flagged by the brief; no historical SMSF transaction store exists, so period selection can only relabel recurring-rate figures | P2 |
| S-10 | SMSF transaction reconciliation / bank import | **N** | **N** | **N** | — | — | — | — | **NEVER IMPLEMENTED** — no PO deferral evidence found | P2 |
| S-11 | Accountant / auditor export | Y (CSV) | Y | Y | Y | Y | — | — | **PARTIALLY IMPLEMENTED** — a CSV exists; PDF/XLSX and the full balance-sheet/audit-metadata content set are not evidenced | P2 |
| S-12 | SMSF contributions excluded from personal contribution forecasting | Partial | Y | Y | Y | Y | **Y (FAIL)** | **N** | PARTIALLY IMPLEMENTED | P2-3 |

---

## G. LR-7 — Insurance and Goals

| ID | Requirement | Main | Depl | UI | LiveDEV | Classification | Sev |
|---|---|---|---|---|---|---|---|
| G-01 | Insurance form-first Add/Edit, cover semantics, premium cash flow, owner | Y | Y | Y | Y | IMPLEMENTED — DEPLOYED | — |
| G-02 | SMSF-paid insurance option, AU-only visibility | Y | Y | Y | — | IMPLEMENTED — DEPLOYED (client-side gate only) | P2-5 |
| G-03 | **Income-protection detection from the catalogue item** | **N** | Y | Y | **Y (FAIL)** | **NEVER IMPLEMENTED** | **P2-2** |
| G-04 | Insurance import | **N** | — | — | — | **NEVER IMPLEMENTED** — no PO acceptance evidence | P2 |
| G-05 | Goal create / edit / manual progress / linked funding / milestones | Y | Y | Y | Y | IMPLEMENTED — DEPLOYED | — |
| G-06 | Goal pause / resume / archive / complete | Y | Y | Y | — | IMPLEMENTED — DEPLOYED | — |
| G-07 | Permanent delete only for unused goals | Y | Y | Y | — | IMPLEMENTED — DEPLOYED | — |
| G-08 | Goal funding provenance consistency (LR-7's own P1 fix) | Y | Y | Y | — | IMPLEMENTED — verified intact | — |
| G-09 | Debt-payoff goal excludes SMSF liabilities | **N** | Y | Y | — | PARTIALLY IMPLEMENTED | P2 |

---

## H. LR-8 — Reports and navigation

| ID | Requirement | Main | ProdDB | ProdStorage | Depl | UI | LiveDEV | LiveProd | Sec | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R-01 | Reports Hub exists, links generated outputs | Y | Y | — | Y | Y | Y | ? | — | IMPLEMENTED — DEPLOYED | — |
| R-02 | Monthly report generation | Y | Y | — | Y | Y | **Y PASS** | ? | — | IMPLEMENTED — DEPLOYED | — |
| R-03 | Premium sections gated at generation | Y | Y | — | Y | Y | Y | ? | Y | IMPLEMENTED — DEPLOYED | — |
| R-04 | **Premium export fails closed at the backend** | **Partial** | Y | **N** | Y | Y | ? | ? | **N** | **PARTIALLY IMPLEMENTED** | **P1-5** |
| R-05 | **Consolidated Forecasting Report PDF export** | **Partial** | Y | — | Y | Y | **N** | **N** | Y | **PARTIALLY IMPLEMENTED** | **P1-6** |
| R-06 | `report-exports` bucket exists in production | Y | — | **N** | — | — | — | **N** | — | **APPLICATION CODE DEPLOYED — INFRASTRUCTURE MISSING** | **P1-9** |
| R-07 | Financial Activity as a generated output under Reports | **Partial** | Y | — | Y | Y | Y | ? | — | **IMPLEMENTED DIFFERENTLY** — the hub links the live operational workspace; no generated artefact exists | P2 |
| R-08 | Operational transaction review stays under Expenses / import | Y | Y | — | Y | Y | Y | — | — | IMPLEMENTED — DEPLOYED | — |
| R-09 | No dead report types | **N** | — | — | — | — | — | — | — | PARTIALLY IMPLEMENTED — 3 of 4 types are title-only variants | P3 |
| R-10 | No orphaned report APIs | **N** | — | — | — | — | — | — | — | PARTIALLY IMPLEMENTED — 13 of 15 route files have no caller | P3 |
| R-11 | No dead navigation | Y | — | — | Y | Y | Y | — | — | IMPLEMENTED — all 33 nav hrefs resolve | — |
| R-12 | Report ownership / no IDOR | Y | Y | — | Y | — | **Y** | — | **Y** | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| R-13 | Cache-control on personal documents | Partial | — | — | Y | — | — | — | Partial | PARTIALLY IMPLEMENTED | P2-11 |
| R-14 | Export filenames do not leak | Partial | — | — | Y | — | — | — | Partial | PARTIALLY IMPLEMENTED | P3 |

---

## I. LR-9 — Legal, accessibility, account closure

| ID | Requirement | Main | ProdDB | Depl | UI | LiveDEV | LiveProd | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|
| L-01 | Privacy / Terms / Disclaimer / Accessibility pages exist and are reachable | Y | — | Y | Footer on `/` only | Y | **Y** | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| L-02 | Privacy copy matches behaviour on uploads | **N** | — | Y | Y | — | **Y (FAIL)** | PARTIALLY IMPLEMENTED | P2-6 |
| L-03 | No absolute deletion-time guarantee | Y | — | Y | Y | — | **Y PASS** | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| L-04 | No unfounded WCAG conformance claim | Y | — | Y | Y | — | **Y PASS** | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| L-05 | Privacy Draft status disclosed | Y | — | Y | Y | — | **Y** | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| L-06 | User requests closure; cannot self-execute | Y | Y | Y | Y | Y | — | IMPLEMENTED — DEPLOYED | — |
| L-07 | Admin B with narrow capability views and executes | Y | Y | Y | **URL only** | Y | **N — 0 requests ever** | IMPLEMENTED — DEPLOYED BUT NOT LIVE-JOURNEY CERTIFIED | P2-13 |
| L-08 | Admin cannot execute their own request | Y | Y | Y | Y | Y | — | IMPLEMENTED — DEPLOYED | — |
| L-09 | Nested storage enumeration correct | Y | — | Y | — | Y | — | IMPLEMENTED — verified intact | — |
| L-10 | **Purge failure aborts identity deletion** | Y | — | Y | — | Y | **Vacuous in production** | PARTIALLY IMPLEMENTED | **P1-9** |
| L-11 | Identity deleted only after verified purge | Y | — | Y | — | Y | Vacuous | PARTIALLY IMPLEMENTED | P1-9 |
| L-12 | DB cascade succeeds | Y | Y | Y | — | **Y PASS** | — | IMPLEMENTED — DEPLOYED | — |
| L-13 | **Deletion always completes** | **N** | Y | Y | — | **Y (FAIL)** | — | PARTIALLY IMPLEMENTED | **P1-8** |
| L-14 | Tombstone survives: request UUID, `user_id` NULL, `processed_by` set | Y | Y | Y | — | **Y PASS** | — | IMPLEMENTED — DEPLOYED | — |
| L-15 | **No financial rows remain** | **N** | Y | Y | — | **Y (FAIL)** | — | PARTIALLY IMPLEMENTED | **P2-1** |
| L-16 | Failed requests retryable | **N** | Y | Y | — | — | — | NEVER IMPLEMENTED | P2-16 |
| L-17 | One bounded synthetic production deletion before terminal closure | **N** | — | — | — | — | **N** | **DEFERRED — PO AUTHORIZED IT, NEVER DONE** | P1 |

---

## J. LR-10 — Payments

| ID | Requirement | Main | ProdDB | ProdConfig | Depl | UI | LiveDEV | LiveProd | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|---|
| P-01 | Stripe AU monthly + annual | Y | Y | **N** | Y | Y | Partial | **N** | **APPLICATION CODE DEPLOYED — CONFIGURATION MISSING** | **P1-2** |
| P-02 | Razorpay India monthly + annual | Y | Y | **N** | Y | Y | Partial | **N** | as above | **P1-2** |
| P-03 | Global never falls back to AU/IN pricing | Y | Y | — | Y | Y | **Y PASS** | ? | IMPLEMENTED — DEPLOYED | — |
| P-04 | No invented Global price anywhere | Y | — | — | Y | Y | **Y PASS** | Y | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| P-05 | Signed webhook, invalid signature rejected | Y | Y | **N** | Y | — | — | **N (503)** | APPLICATION CODE DEPLOYED — CONFIGURATION MISSING | P1-2 |
| P-06 | Idempotency, duplicate webhook safe | Partial | Y | — | Y | — | — | — | PARTIALLY IMPLEMENTED | P2-7 |
| P-07 | Premium granted only by webhook | Y | Y | — | Y | — | **Y** | **Y** (0 premium entitlements ever) | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| P-08 | Cancelled / past_due / failed lifecycle | Y | Y | — | Y | — | — | — | IMPLEMENTED — MAIN ONLY | P2-9 |
| P-09 | Billing country cannot change under an active subscription | Partial | Y | — | Y | Y | — | — | PARTIALLY IMPLEMENTED | P2-8 |
| P-10 | No secrets in source, history, logs, migrations, tests, reports | Y | — | — | — | — | **Y PASS** | Y | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| P-11 | Live checkout → webhook → entitlement round trip | **N** | — | **N** | — | — | — | **N** | **DEFERRED — PO AUTHORIZED IT, NEVER DONE IN PRODUCTION** | P1-2 |

---

## K. LR-11 / LR-11B — Entities

| ID | Requirement | Main | DevDB | ProdDB | Depl | UI | LiveDEV | LiveProd | Sec | Classification | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E-01 | Company create / edit / archive | Y | Y | Y | Y | Y | **Y PASS** | ? | Y | IMPLEMENTED — DEPLOYED | — |
| E-02 | Summary / Detailed valuation | Y | Y | Y | Y | Y | **Y PASS** | ? | Y | IMPLEMENTED — DEPLOYED | — |
| E-03 | Ownership % × entity NAV into Net Worth | Y | Y | Y | Y | Y | **Y PASS** | ? | — | IMPLEMENTED — DEPLOYED | — |
| E-04 | Entity liabilities excluded from personal DTI/DSR | Y | Y | Y | Y | Y | **Y PASS** | — | Y | IMPLEMENTED — PRODUCTION CERTIFIED (structural) | — |
| E-05 | RLS / cross-tenant on all three entity tables | Y | Y | Y | Y | — | **Y PASS** | — | **Y** | IMPLEMENTED — PRODUCTION CERTIFIED | — |
| E-06 | **Family Trust create / edit / archive** | Y | Y | **N** | Y | Y | **Y PASS** | **N — DB rejects it** | Y | **APPLICATION CODE DEPLOYED — DATABASE MISSING** | **P1-1** |
| E-07 | Entity value visible to the user | **N** | — | — | Y | **N** | **Y (FAIL)** | — | — | PARTIALLY IMPLEMENTED | P2-4 |
| E-08 | Entity Income / Expenses | **N** | **N** | **N** | — | — | — | — | — | **NEVER IMPLEMENTED** (WP-07 deferred) | P2 |
| E-09 | Entity reports / exports | **N** | — | — | — | — | — | — | — | **NEVER IMPLEMENTED** (WP-08 deferred) | P2 |
| E-10 | Child entity remains discovery-only | Y | — | — | Y | — | **Y PASS** | — | — | **OBSOLETE — SUPERSEDED BY EXPLICIT PO DECISION (verified intact)** | — |
| E-11 | Entity DB-layer country backstop | **N** | **N** | **N** | — | — | — | — | Partial | PARTIALLY IMPLEMENTED | P2-14 |

---

## L. Migration reconciliation (Section 28)

| Migration | On main | DEV applied | PROD applied | Drift |
|---|---|---|---|---|
| `0129` g5b generic write enablement | Y | **Y** | **Y** | — |
| `0130` g5b MCC-14 cascade exemption | Y | Y | Y (assumed — function body not introspectable) | — |
| `0131` LR-3 bank-import surplus bridge | Y | **Y** | **Y** | — |
| `0132` LR-9 account closure | Y | **Y** | **Y** | — |
| `0133` LR-10 payment operationalisation | Y | **Y** | **Y** | — |
| `0134` LR-11 business entity registry | Y | **Y** | **Y** | — |
| `0135` LR-1 purge sweep scheduler | Y | Y | Y (endpoint live-proven) | committed file still ships the placeholder URL |
| **`0136` LR-11B Family Trust** | Y | **Y** | **NO** | **DRIFT — P1-1** |
| `0137` SMSF SECURITY DEFINER cascade fix | Y | **Y** | **Y** | **Applied, and it introduced P0-2** |
| `0138` G6 country_code columns | Y | **Y** | **Y** | — |
| `0139` G6 snapshot FX lineage | Y | **Y** | **Y** | — |
| `0147` G8 generic archive bypass fix | Y | Y | Y (assumed) | — |

**Numbering gaps on main:** `0079`–`0081`, `0103`, `0128`, `0140`–`0146` are absent. `0128` is explained — LR-1's migration was renumbered `0128` → `0135` during the sibling-branch reconciliation. The others were not investigated; no duplicates exist and no evidence of historical mutation was found.

**Other DEV↔PROD schema drift found:** `aie_ai_cost_ledger` and `aie_ai_cost_attempt` tables, the `aie_reserve_ai_cost` / `aie_settle_ai_cost` RPCs, six `aie_document_intake` purge columns, `fdh_parser_versions.certified_extraction_methods`, and three `fdh_statement_uploads` columns are **DEV-only**. One RPC, `r12_production_precheck`, is **production-only** — a leftover from LR-12 certification and a Section 39 cleanup item. None of these are LR-programme requirements; they are recorded for completeness.

---

## M. Cleanup (Section 39)

| Item | Status |
|---|---|
| Synthetic DEV users created by this audit | **All deleted.** A sweep (`oracle7 --sweep`) removed the one user whose deletion was blocked by the P1-8 probe, after the probe row was removed |
| Synthetic DEV rows (`business_entities`, `ii_analytics_results`, `benchmark_sources` probe) | **All deleted** |
| Persona pack (3 DEV users) | **All deleted.** Recreate with `npx tsx scripts/audit-lr/a12_make_personas.ts` if needed |
| Persona SMSF fund / holding seeded for the P0-2 UI observation | **Removed with its owner** |
| Production writes by this audit | **None.** All constraint probes referenced a nonexistent user and were confirmed to have written zero rows; the production janitor call was a proven no-op sweep |
| Production upload files created | **None** |
| `r12_production_precheck` RPC in production | **Outstanding** — pre-existing LR-12 leftover, not created by this audit |
| Source / migration / production-config changes by this audit | **None** |

**Zero-residue statement, proven** (`scripts/audit-lr/a18_zero_residue_proof.mjs`, run after cleanup):

```
DEV   audit auth users remaining .......................... 0
DEV   business_entities matching the probe name ........... 0
DEV   ii_analytics_results probe rows ...................... 0
DEV   benchmark_sources probe rows ......................... 0
PROD  auth users created by this audit ..................... 0
PROD  total auth users ..................................... 7   (unchanged)
PROD  business_entities .................................... 0   (unchanged)
PROD  account_deletion_requests ............................ 0   (unchanged)
PROD  fdh_statement_uploads ................................ 0   (unchanged)
PROD  report_exports ....................................... 0   (unchanged)
PROD  payment_webhook_events ............................... 0   (unchanged)
PROD  investment-source-documents storage entries .......... 1   (unchanged)
```

This audit created no production data, no production file, and no production configuration change, and removed every DEV artefact it created.
