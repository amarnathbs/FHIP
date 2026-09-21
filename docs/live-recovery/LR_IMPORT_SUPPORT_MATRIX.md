# LR Import Support Matrix

## 2026-09-21 ADDENDUM

Re-read directly against current `origin/main` (not relabelled from the 09-14 prose below). Two real changes, one non-change worth naming precisely:

1. **"Production enabled?" flips from No to Yes-with-caveats for every FDH-3 row** (Expenses AU/IN CSV+PDF, Income/Payslip, Liabilities AU/IN, Investments AU, Retirement) — `isFdhDocumentUploadEnabled()`'s hard project-ref allowlist now includes the real production Supabase project (commit `c4891185`, 2026-09-20, explicit PO decision — see `LR_2026_09_21_RECONCILIATION_ADDENDUM.md`). This is **not** the same as "Production certified" — that column is unchanged (**No**, still) because the malware-scanning prerequisite the "Outstanding blocker" column already named is still unmet, confirmed by direct inspection this pass (no route in `app/api/financial-data-hub/**` references scanning). Whether uploads can complete a storage write in production (the `fdh-source-documents` bucket's current existence) is a genuine Cannot-Verify — production credentials were deliberately withheld from this audit pass.
2. **P1-7 (Expenses: nothing parses the panel's upload) is confirmed UNCHANGED** — re-checked directly this pass (`grep` over `components/**` and `app/(app)/**` for any caller of the bank-csv/bank-pdf `.../process` routes returns zero, same as 09-14). This matters precisely because it means opening the production gate on 2026-09-20 did **not** fix the Expenses journey — a production user can now technically reach the upload endpoint (gate is open), but the upload still dead-ends exactly as it did in DEV on 09-14. The other four FDH surfaces (Income, Liabilities, Investments AU, Retirement) do not share this specific defect — their own panels do reach the process/apply routes.
3. **India CAS/CAMS row's "Raw deletion?" column changes from "No — none" to "Partial, going-forward only"** — migration `0161` (2026-09-19, confirmed on `origin/main`) wires a real delete-after-parse call, independently traced this pass to a genuine call site in `documentProcessing.ts:1201`, not dead code. It does not retroactively purge documents already uploaded before `0161` shipped.

None of the other cells below were independently re-verified this pass (named institutions coverage, liability field mapping, the import-bridge architecture) — they are carried forward from 09-14 as still the best available evidence.

---

## 1. The matrix

| Module | Country | Document type | Format / provider | Upload available? | Parser real? | Malware scanned? | Review? | Accept? | Apply? | Canonical destination | Raw deletion? | Production enabled? | Production certified? | Outstanding blocker |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Expenses | AU | Bank statement | CSV — 5 named banks (CBA, Westpac, NAB, ANZ, Macquarie) + generic | Yes (panel) | **Yes** | **No** | Yes | Yes | n/a¹ | `fdh_transactions` → Dashboard via `0131` bridge | Yes | **No** | No | **P1-7: nothing parses the panel's upload**; gate OFF; no scanner; bucket absent |
| Expenses | IN | Bank statement | CSV — 5 named banks (SBI, HDFC, ICICI, Axis, Kotak) + generic | Yes (panel) | **Yes** | **No** | Yes | Yes | n/a¹ | `fdh_transactions` | Yes | **No** | No | same |
| Expenses | AU | Bank statement | PDF — 4 named banks (CBA, ANZ, NAB, Westpac) | Yes (panel) | **Yes** (`pdf-parse`) | **No** | Yes | Yes | n/a¹ | `fdh_transactions` | Yes | **No** | No | same; **no OCR** — scanned statements refused |
| Expenses | IN | Bank statement | PDF — 4 named banks (SBI, HDFC, ICICI, Axis) | Yes (panel) | **Yes** | **No** | Yes | Yes | n/a¹ | `fdh_transactions` | Yes | **No** | No | same |
| Income | AU / IN | Payslip | PDF | Yes (panel) | **Yes** (`payslip/parser.ts`, AU+IN signal detection, two-column YTD) | **No** | Yes | Yes | **Yes** | **`income_sources`** via `fdh9_apply_income_proposal` | Yes | **No** | No | gate OFF; no scanner; bucket absent. **No CSV payslip path, no OCR** |
| Liabilities | AU | Liability statement | CSV — 2 generic adapters (`au_credit_card_generic_v1`, `au_loan_generic_v1`), **zero named lenders** | Yes (panel) | Yes | **No** | Yes | Yes | **Yes** | **`liabilities`** via `fdh10_apply_liability_proposal` | Yes | **No** | No | gate OFF. **PDF not supported at all** |
| Liabilities | IN | Liability statement | CSV — 2 generic adapters (`in_credit_card_generic_v1`, `in_loan_emi_generic_v1`) | Yes (panel) | Yes | **No** | Yes | Yes | **Yes** | `liabilities` | Yes | **No** | No | same |
| Investments | AU | Investment statement | CSV — 2 broker-neutral generic adapters, **zero named brokers** | Yes (panel) | Yes | **No** | Yes | Yes | Yes | **`ii_holding_snapshots` / `ii_transactions` — NOT `investments`** | Yes | **No** | No | gate OFF **+ a second, manual publish step** |
| Investments | AU | Broker statement | PDF | **No** | — | — | — | — | — | — | — | No | No | **Does not exist.** `FDH11_AU_BROKER_ADAPTERS.md:9-15` lists CommSec, CMC, Selfwealth, Stake, nabtrade, Westpac, Macquarie as UNSUPPORTED |
| Investments | IN | CAS / demat statement | PDF — CAMS, CAMS folio, KFintech (3 parsers, ~2,300 lines) | **Yes** | **Yes** | **No** | Yes | Yes (certify/resolve) | **Yes** (`positions/[id]/publish`) | **`investments`** | **No — none** | **YES** | **No** | **P1-3: ungated, unscanned, never purged.** Asset-class allowlist limits publishing to mutual_fund / equity / etf |
| Retirement | AU / IN | Super / EPF / NPS statement | CSV — 4 generic fund-neutral adapters, **zero named funds** | Yes (panel) | Yes | **No** | Yes | Yes | **Yes** | **`retirement_accounts`** via `fdh12_apply_retirement_proposal` | Yes | **No** | No | gate OFF. **PDF explicitly refused** (`layout_unsupported` / `pdf_manual_mapping_required`) |
| Insurance | any | any | — | **No** | — | — | — | — | — | — | — | No | No | **Does not exist.** `insurance_policy` is not in `FDH_DOCUMENT_TYPES` |
| SMSF / entity | AU | any | — | **No** | — | — | — | — | — | — | — | No | No | **Does not exist.** SMSF statements are actively refused by the retirement adapter |
| Assets | any | any | — | **No** | — | — | — | — | — | — | — | No | No | **Does not exist** |

¹ Expenses has no import-bridge "Apply" step by design: approved bank transactions are read directly by the Dashboard engine and the `superseded_by_bank_import` flag prevents double counting. See §4.

---

## 2. Named-institution coverage — the honest count

| Family | Named institutions supported |
|---|---|
| Bank CSV | **10** — AU: Commonwealth Bank, Westpac, NAB, ANZ, Macquarie. India: SBI, HDFC, ICICI, Axis, Kotak Mahindra. Plus 2 country-neutral generic fallbacks (score-penalised ×0.95) |
| Bank PDF | **8** — AU: CBA, ANZ, NAB, Westpac. India: SBI, HDFC, ICICI, Axis. **No Kotak, no Macquarie, no generic fallback** |
| Liability statements | **0** — 4 generic column-contract adapters only |
| AU investment statements | **0** — 2 broker-neutral generic adapters only |
| Retirement statements | **0** — 4 generic fund-neutral adapters only |
| India CAS | **CAMS, CAMS folio statement, KFintech** — real, production-live |

**Every statement family except bank statements and India CAS is generic-CSV-contract only.** If the original LR-4 requirement named specific institutions or a broker import journey, that scope is not implemented; the AU broker document explicitly records those brokers as UNSUPPORTED.

---

## 3. Reachability — what a real user can actually do

**Reachable AND live in production:** the India CAS/CAMS journey at `/investment-intelligence/data`, ending in a real publish into `investments`. This is the only one.

**Reachable in the UI but inert in production** (each shows an amber disclosure once `/api/financial-data-hub/upload-status` resolves): Expenses, Income, Liabilities, Investments AU, Retirement.

**Backend-only, no user entry point at all:**
- The entire bank statement parsing engine. `processBankCsvDocument` / `processBankPdfDocument` are called only from `bank-csv/[documentId]/process` and `bank-pdf/[documentId]/process`, and **no component or page anywhere calls those routes** (grep over `components/**/*.tsx` and `app/(app)/**/*.tsx` returns zero). All 10 CSV and 8 PDF adapters are unreachable.
- `app/(app)/financial-data-hub/page.tsx`, the standalone upload screen — no nav link, no in-app link, direct URL only.

**Does not exist:** insurance documents, SMSF/entity documents, asset documents.

---

## 4. LR-3's canonical-write question, answered precisely

The audit brief asks whether treating approved bank transactions as canonical for Expenses was PO-authorised, and whether "approved" means Apply.

**What the code does.** `lib/services/dashboardData.ts:200-224` reads `fdh_transactions` where `approval_status='approved'` and `economic_transaction_type` is in the expense or income sets, for the current month, and feeds them into `totalMonthlyExpenses` and gross income. `debt_principal` and `transfer` are excluded; refunds are netted negative (`dashboardData.ts:266-283`). Double counting against manual rows is prevented by the explicit, user-set `superseded_by_bank_import` flag introduced by migration `0131`, whose header states the rule plainly:

> "the user explicitly marks a manual `income_sources`/`expense_items` row as 'now tracked via bank import instead' … Defaults FALSE for every existing and new row, so no existing household's total changes until they explicitly opt a row out."

**So yes: for Expenses, "approved" is the Apply step, deliberately and without fuzzy matching.** That design is sound and correctly documented at the migration level. What is missing is any PO authority in this repository for the decision itself, and — more importantly — **any way for a user to reach it**: the panel that offers bank-statement import cannot cause a single transaction to be parsed (P1-7).

**Staged data cannot affect calculations before approval:** the engine filters on `approval_status='approved'`, so a pending transaction is invisible to every household metric. That invariant holds.

---

## 5. The AU Investments second-publish step

An approved AU investment statement applies into `ii_holding_snapshots` / `ii_transactions`, **not** into `investments`. Reaching the canonical register requires a second, separate, manual action: `POST /api/investment-intelligence/positions/[id]/publish`, which enforces an asset-class allowlist (`mutual_fund`, `equity`, `etf`) and a duplicate-review gate that returns `REVIEW_REQUIRED` unless the user acknowledges no duplicate or links to an existing investment.

**No PO authorisation for this two-step design was found in this repository.** It is recorded as `IMPLEMENTED DIFFERENTLY — NO PO AUTHORIZATION FOUND`, pending a ruling. (The design is defensible — it keeps evidence and canonical truth separate — but the audit brief specifically asks whether the second step was authorised, and the answer available from the evidence is "not demonstrably".)

---

## 6. Liability statement extracted fields vs the requested set

| Requested field | Reaches `liabilities`? |
|---|---|
| Total balance | **Yes** |
| Installment / payment amount | **Yes** (`monthly_repayment`; for a credit card this is the minimum payment and carries `requiresConfirmation`) |
| Monthly interest charged | **No — evidence only**, never written to canonical |
| Interest rate | **Yes, loans only** — explicitly refused for credit cards |
| Fees | **No — evidence only** |
| Liability type | **Yes** (on create only) |
| Lender | **Yes** (on create only) |

Two of the seven requested fields are captured as statement evidence and never reach the canonical register. Classified `PARTIALLY IMPLEMENTED`.

---

## 7. The import-bridge machinery

`fhip_import_proposals` / `fhip_import_proposal_fields` / `fhip_import_applications` (migration `0091`) plus `lib/import-bridge/` implement **Preview → Compare → User Approval → Apply**: a proposal is inert, and only Apply mutates canonical data. It enforces an adapter allow-list, value-based staleness detection, and selected-field patches.

**Users: Income, Liabilities, Retirement only.** Investments AU uses a separate narrow bridge that explicitly declines to reuse it. **Expenses has no bridge at all**, by the design described in §4.

The bridge lives outside `lib/financial-data-hub/` deliberately, because `tests/unit/fdh1Isolation.test.ts` forbids Hub code from touching the protected input tables. **That isolation test currently fails on `origin/main`** — see the Baseline Failure Register.
