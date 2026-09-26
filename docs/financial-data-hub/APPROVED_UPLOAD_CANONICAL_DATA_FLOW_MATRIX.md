# APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX

Baseline: origin/main `a115ee5`, read-only discovery copy. This file consolidates the seven domain maps. Conflicts between maps were settled by reading the code (see "Architect verification" at the end). Every field and event a map reported appears below; nothing was sampled.

## Legend

**Classification:** A canonical state · B canonical event (fdh_transactions + allocations/links) · C evidence (must be user-visible) · D derived/technical metadata · E explicitly unsupported (visible explanation).

**User reviewed?:** Y = shown in the pre-Apply review · P = partially (totals only / label only) · N = never shown.

**Consumers:**
- DB* = every `loadDashboard` consumer: Dashboard, Health Score, DNA, Resilience, Goals, Forecast, Reports, Recommendations, AI context, section-status.
- NW Net Worth · CF Cashflow/Surplus · TW Twin/Benchmark · RP Reports · EX report/forecast exports.
- ACT FDH Activity · CR category review.
- ET/IT/LT/INV/RT = the Expenses/Income/Liabilities/Investments/Retirement tabs · IIS Investment Intelligence screens.

**Fix:** the owning work package (WP-xx) followed by the change.

**Approval objects per source:**
- BANK: `fdh_transactions` row approval (approvalService.ts:59-111; approve-group/approve-all categoryReviewService.ts:234-286) plus statement approve (approvalService.ts:171-323).
- PAYSLIP: `fdh_payroll_events` approve RPC (0091:1381-1408), then `fhip_import_proposals` Apply via `fdh9_apply_income_proposal` (0120:45-254).
- LIAB: statement approve `fdh10_approve_liability_statement` (0096:525-552), then Apply `fdh10_apply_liability_proposal` (0096:766-976).
- AUINV: statement approve (investment-statement/[documentId]/approve/route.ts:9), then apply route (apply/route.ts:17-65).
- IICAS: process, then portfolio-truth certify, then publish.
- RET: `fdh12_approve_retirement_statement` (0112:1131; 0113:149), then Apply `fdh12_apply_retirement_proposal` (0119:54).
- INS: AIE run accept. ACTIVE USER FLOW: NO.

## 1. BANK statements (CSV + native PDF + AI-fallback draft) — Expenses → Import bank statement (expenses/page.tsx:31-53)

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| BANK | row.transactionDate | B | Y | fdh_transactions | fdh_transactions.transaction_date (bankCsvProcessingService.ts:404; bankPdfProcessingService.ts:564) | same; read models use it as the economic date over complete covered months, not the current UTC calendar month (dashboardData.ts:8-17,210-211) | DB*(current month only), ACT, CR | DC-01 / EXP-G3 | WP-02 window+coverage; WP-03 consume |
| BANK | row.postedDate (CSV; PDF null :565) | C | N | fdh_transactions | posting_date (csv :405) | statement-details drawer | none | EXP-G14 | WP-08 render |
| BANK | row.valueDate (CSV; PDF null :566) | C | N | fdh_transactions | value_date (csv :406) | statement-details drawer | none | EXP-G14 | WP-08 render |
| BANK | row.descriptionRaw | C | P (clean shown) | fdh_transactions | description_raw (csv :407, pdf :567), purgeable | unchanged | ACT | No | — |
| BANK | row.descriptionClean | B attr (payee) | Y | fdh_transactions | description_clean (csv :408, pdf :568) | also the Expenses-tab actual line label | ACT, CR; not ET | EXP-G1 | WP-07 |
| BANK | row.referenceRaw (CSV; PDF source_reference null :573) | C + D (dedup key) | N | fdh_transactions | source_reference; dedup (bank-csv/repository.ts:51), transfer matching (transferMatching.ts:133) | line detail | none | EXP-G14 | WP-08 render |
| BANK | row.amountOriginal | B | Y | fdh_transactions | amount_original (csv :409, pdf :569) | unchanged | DB*, ACT, CR | No | — |
| BANK | row.creditDebit | B (direction only) | Y | fdh_transactions | credit_debit | unchanged | ACT | No | — |
| BANK | currency (document-declared, validation/bankCsv.ts:26; per-row column accepted ~:55 but ignored by normalize.ts:18-56) | B | P | fdh_transactions | currency_original (csv :410, pdf :570) = document currency | honour the per-row column, or reject the mapping with a visible E message | DB* (converted per row, dashboard.ts:642-649) | EXP-G14 | WP-08 |
| BANK | row.balanceAfter | C / D | N | fdh_transactions | balance_after (dedup evidence repository.ts:51; rollforward) | statement details | none | EXP-G14 | WP-08 render |
| BANK | row.transactionTypeHint (normalize.ts:116-129) | D | N | fdh_transactions | transaction_type_hint → economicTypeEngine | unchanged | classification | No | — |
| BANK | sourceRowNumber / PDF sourcePage | D | N | fdh_transactions | source_row / source_page (pdf :574-575) | unchanged | — | No | — |
| BANK | extractionConfidence (PDF normalize.ts:94; CSV 1 at :415; AI 0 orchestrator.ts:472) | D | P | fdh_transactions | extraction_confidence | unchanged | CR low-confidence gate | No | — |
| BANK | sourceRowHash / economicFingerprint / version / dedupStatus | D | P | fdh_transactions | csv :417-420 | dedup_status excluded in EVERY actual read | DB ignores it (dashboardData.ts:203-213,266-276) | EXP-G4 / DC-03 | WP-02 exclusion; WP-08 cascade + classification |
| BANK | economic_transaction_type (inserted 'unknown' csv :412/pdf :572, then R8 or user) | B | Y | fdh_transactions | column | every enum value mapped to exactly one read-model bucket | DB*, ACT, CR | EXP-G2 | WP-02 (plus registry economicTransactionType.ts, WP-00) |
| BANK | category_id / subcategory_id | B | Y | fdh_transactions | columns (classification / setTransactionCategory) | Expense read model: canonical category group via fdh_categories/subcategories.fhip_mapping_key; essential flag from essential_discretionary (0053:43,72) | CR, ACT; not ET | EXP-G1 / EXP-G6 / DC-11 | WP-02 mapping; WP-07 display |
| BANK | split allocations (transactionSplitService.ts:113-130) | B | N (no split UI) | fdh_transaction_allocations | table; honoured by approvedSummary.ts:183-200 and Activity; ignored by DB (dashboardData.ts:206-209) | the allocation replaces the parent in every consumer | ACT, DB (wrong) | EXP-G5 | WP-02 read; WP-08 atomic RPC (0212), approved-row guard, split UI, reject 'unknown' |
| BANK | user corrections | B (value) + C (history) | Y | fdh_transaction_corrections | in-place update (bankTransactionActionsService.ts:138-162); no approval guard | refused on approved rows unless the statement is reopened | DB (moves immediately); approved summary goes stale | EXP-G12 | WP-08 |
| BANK | statement_period_* (CSV user-declared) | C | Y | statement | fdh_statement_uploads (bankCsvUploadService.ts:116-117) | also the coverage input | CR header | No | — |
| BANK | statementPeriodStart/End (PDF metadata.ts:62-63; AI bankPdfProcessingService.ts:1034-1035) | C | Y (pre-persist) | statement | used only for date coverage; never persisted (persist :800-814) | fdh_statement_uploads.statement_period_* when null; drives coverage | CR header shows null | EXP-G14 / EXP-G3 | WP-08 |
| BANK | declaredOpening/ClosingBalance (PDF metadata.ts:59-60; AI) | C (closing is an A candidate — PO D-04) | P | statement | fdh_reconciliation_results (bankPdf :676,680) | per D-04: an asset proposal (A), or a visible "Bank balance per statement — not in Net Worth" (C) | review-summary route only (:100-109) | DC-16 | WP-08 visible; WP-02 selectAssets evidence bucket |
| BANK | maskedAccountIdentifier (PDF metadata.ts:45-56; AI) | D (account identity) | P | statement | DROPPED | account matching, or explicit D in the registry | none | EXP-G14 | WP-08 |
| BANK | declared_masked_identifier (user input) | D | Y | statement | fdh_financial_accounts.masked_identifier + fingerprint (bankCsvUploadService.ts:74-96) | unchanged | — | No | — |
| BANK | account owner (self/spouse/joint/smsf) | A attribute | N (not asked) | account | absent (0047:61-66; bankCsvUploadService.ts:81-90) | fdh_financial_accounts.owner_role (0207), captured at upload | DB* adds every actual to the household; SMSF not separable | EXP-G13 | WP-01 column; WP-08 capture; WP-02 filter (D-10) |
| BANK | AI draft institutionName | D / C | Y | AI draft | panel only (BankStatementImportPanel.tsx:577); fdh_ai_fallback_drafts.payload | account display_name, or registry D | none | EXP-G14 | WP-08 |
| BANK | AI draft allTransactionsListed / warnings | C | Y | AI draft | panel (:595) + draft payload only | statement DQ result, visible; incomplete extraction forces review | none after confirm | EXP-G14 / EXP-G15 | WP-08 |
| BANK | AI fallback 80-row cap (lib/aie/adapters/bankStatement/schema.ts:40-58) | E | P | AI draft | truncation passes when reconciliation is not_available | blocking "incomplete extraction" review item | — | EXP-G15 | WP-08 |
| BANK | rejected rows (CSV pipeline.rejected; PDF rejected + unparseableBlocks) | E | N | statement | counts only (csv :529-534; pdf :696-700); reasons discarded; success copy omits them (panel :726-737) | "N lines could not be read" plus reasons, in the panel and statement details | — | EXP-G14 | WP-08 |
| BANK | reconciliation result | C | Y | statement | fdh_reconciliation_results + reconciliation_status | unchanged | review-summary | No | — |
| BANK | data-quality checks | D | N | statement | fdh_data_quality_results (csv :559-567; pdf :722-730) | unchanged | — | No | — |
| BANK | statement provenance | D | N | statement | fdh_data_provenance (csv :571-584; pdf :732-745) | unchanged | — | No | — |
| BANK | duplicate_confirmed rows | D | Y (count) | ingest | not inserted; duplicate_row_count (csv :389-390,650) | unchanged | panel | No | — |
| BANK | duplicate_candidate pairs | D + user decision | Y | fdh_duplicate_candidates | pending; blocks approval (0085:93-96); after removed_b the excluded row is still classified (transactionClassificationService.ts:91-100), cascade-approved (approvalService.ts:186-193) and counted | the excluded side is never classified, approved or counted; the statement can still be finalised | DB counts twice | EXP-G4 | WP-08 (0212 blocking functions ignore excluded duplicates); WP-02 |
| BANK | overlapping-statement evidence | C | N | statement | computed then discarded (bankCsvProcessingService.ts:494-500,620; bankPdf :643-648) | info DQ note, visible | — | EXP-G17 | WP-08 |
| BANK | Approved Financial Summary | D (snapshot) | Y | statement | fdh_approved_financial_summaries (approvalService.ts:263-289); ≤1000 rows; UUID labels (:258-261) | D snapshot only, never read downstream; paged; display names | ACT | EXP-G8 / EXP-G18 | WP-08 |
| BANK | approval of a 1001-row statement | D | Y | statement | unpaged select + single .in() (approvalService.ts:113-137,186-193,348-358); review-summary counts ≤1000 (route.ts:62-97); ~3 round trips per row | fetchAllRows + 100-id chunks; set-based approve RPC | DB | EXP-G8 | WP-08 (0212) |
| BANK | event type: income | B | Y | fdh_transactions | DB current month only, added to gross AND net (dashboardData.ts:214-224; dashboard.ts:642-655) | selectIncome actual, deduped against payslip (bank_match_transaction_id) | DB*, ACT; not IT | GAP-01 / DC-01 / DC-02 | WP-02, WP-03, WP-09 (IT section) |
| BANK | event type: expense | B | Y | fdh_transactions | DB current month only (dashboardData.ts:203-213 → dashboard.ts:735) | selectExpenses actual; shown on ET | DB*, ACT, CR; not ET | EXP-G1 / EXP-G2 / DC-01 | WP-02, WP-03, WP-07 |
| BANK | event type: fee | B | Y | fdh_transactions | DB spending (dashboardData.ts:31); approvedSummary fee_total (:129) | spending, unless it is facility-linked debt service | DB* | EXP-G2 | WP-02 |
| BANK | event type: tax | B | Y | fdh_transactions | DB spending; approvedSummary tax_total | spending sub-bucket "tax" | DB* | EXP-G2 | WP-02 |
| BANK | event type: debt_interest | B | Y | fdh_transactions | DB spending AND liabilities.monthly_repayment (dashboard.ts:743,758) | cost of debt; counted once (debt-service rule, D-09) | DB* (double count) | EXP-G7 / DC-06 | WP-02, WP-03 |
| BANK | event type: debt_principal | B | Y | fdh_transactions | fdh_transactions only | non-spending "debt principal"; actual debt service via the liability link | none | EXP-G16 | WP-02 bucket; WP-11 link |
| BANK | event type: transfer | B | Y | fdh_transactions | excluded from spending everywhere (dashboardData.ts:31; approvedSummary.ts:38-45) | unchanged, labelled non-spending | ACT, CR "Not counted" | No (ALREADY CLOSED) | — |
| BANK | event type: refund | B | Y | fdh_transactions | DB nets every refund (dashboardData.ts:266-280); approvedSummary nets confirmed links only (:209-226); CR always reduces (categoryReview.ts:73,437) | one rule (PO D-01) | DB*, ACT, CR disagree | EXP-G9 | WP-02 rule; WP-08 CR adopts the shared rule |
| BANK | event type: investment | B | Y | fdh_transactions | fdh_transactions only | non-spending "invested"; investment_funding corroboration from the broker activity | none | EXP-G16 / INV-G4 | WP-02, WP-12 |
| BANK | event type: asset_purchase | B | Y | fdh_transactions | fdh_transactions only | non-spending bucket, visible (no asset-import flow exists) | none | EXP-G16 | WP-02 |
| BANK | event type: asset_sale | B | Y | fdh_transactions | fdh_transactions only | non-income bucket, visible | none | EXP-G16 | WP-02 |
| BANK | event type: cash_withdrawal | B | Y | fdh_transactions | excluded (dashboardData.ts:28) | "cash — spending unknown" bucket with visible note (PO D-03) | none | EXP-G16 | WP-02 |
| BANK | event type: unknown (parent) | B pending | Y | fdh_transactions | blocked from approval (0085:61-79); needs_decision (categoryReview.ts:313) | unchanged | — | No (ALREADY CLOSED) | — |
| BANK | event type: unknown (allocation line) | B pending | N | fdh_transaction_allocations | accepted (validation/transactions.ts:253); a reconciled split lifts the block | rejected | ACT | EXP-G5 residual | WP-08 |

## 2. PAYSLIP → Income (Income → Import from Payslip, income/page.tsx:31-53) and bank salary credits

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| PAYSLIP | employerName | A | Y | event+proposal | fdh_payroll_events.employer_name (0091:86) → income_sources.employer_name/source_name (incomeAdapter.ts:233-245); the only duplicate key (:178-192) | unchanged; null employer handled by event-level idempotency | IT, DB* | GAP-04 (null case) | WP-09 |
| PAYSLIP | employer_normalised | D | N | event | 0091:89 | unchanged | — | No | — |
| PAYSLIP | member / owner | A (user-chosen) | N | event+proposal | hard-coded 'self' (0120:223-225; incomeAdapter.ts:338-340); candidates filtered to self (incomeProposalService.ts:143-148) | fdh_payroll_events.income_owner (0207), chosen at upload; RPC scopes to it | IT, DB* (spouse salary becomes a self row) | GAP-05 | WP-09 (0210) |
| PAYSLIP | country_code | D | N | event | 0091:90 | unchanged | — | No | — |
| PAYSLIP | currencyCode | A | Y | event+proposal | written on add_new only (incomeAdapter.ts:282-284); update_existing does no currency check (0120:141-230); DB never selects it (dashboardData.ts:130) | honoured on write (CURRENCY_MISMATCH) and on every read (converted once) | DB* sums raw INR+AUD | GAP-03 | WP-09 (0210); WP-02 / WP-03 |
| PAYSLIP | payPeriodStart / payPeriodEnd | C | Y | event | 0091:93-94 | payslip details reachable from the imported Income row | none after apply | GAP-07 | WP-09 |
| PAYSLIP | paymentDate | C (economic date) | N | event | 0091:95; bank-match only (payslipProcessingService.ts:252-270) | payslip details + income actual line date | none | GAP-07 | WP-09 |
| PAYSLIP | payFrequency / pay_frequency_source | A (semimonthly/irregular/unknown: user chooses) | Y | proposal | income_sources.frequency (incomeProposalService.ts:37-46; incomeAdapter.ts:272-280); requires confirmation unless stated (:274) | user-confirmed frequency; never auto-applied on update_existing | IT, DB* | GAP-12 / X-01 | WP-09 |
| PAYSLIP | grossPay | A | Y | proposal | income_sources.amount = recurring gross (incomeAdapter.ts:143-156,248-257) | unchanged | IT, DB* | No | — |
| PAYSLIP | gross_pay_source | D | Y | event | 0185; payslipProcessingService.ts:672 | unchanged | — | No | — |
| PAYSLIP | basePay | C | Y | event | 0091:110; not read by proposal (incomeProposalService.ts:123) | payslip details | none | GAP-07 | WP-09 |
| PAYSLIP | overtimePay | B one-off or C (PO D-06) | Y (if >0) | event | subtracted from recurring gross (incomeAdapter.ts:145-150) | per D-06 | none | GAP-08 | WP-02 (income actual) + WP-09 |
| PAYSLIP | bonusPay | B one-off or C (D-06) | Y (if >0) | event | subtracted | per D-06 | none | GAP-08 | WP-02 + WP-09 |
| PAYSLIP | commissionPay | B one-off or C (D-06) | N; not correctable (PayslipImportPanel.tsx:130-141) | event | subtracted | per D-06 + visible + correctable | none | GAP-07 / GAP-08 | WP-09 |
| PAYSLIP | allowancesTotal | A (inside gross) + C | N | event | stays inside recurring gross | component shown | none | GAP-07 | WP-09 |
| PAYSLIP | reimbursementsTotal | E (not income), visible | N | event | always subtracted (incomeProposalService.ts:97-102) | visible "not income"; subtracted only when the components prove it is inside gross | none | GAP-07 / GAP-16 | WP-09 |
| PAYSLIP | otherEarnings | B / C (D-06) | N | event | treated as arrears and subtracted (incomeProposalService.ts:95) | per D-06, visible | none | GAP-07 / GAP-08 | WP-09 |
| PAYSLIP | taxWithheld | C | Y | event | 0091:124 | payslip details | none | GAP-07 | WP-09 |
| PAYSLIP | employeeDeductionsTotal | C | N | event | column | payslip details | none | GAP-07 | WP-09 |
| PAYSLIP | salarySacrifice | C + explicit gross basis | N | event | 0091:129; ignored in gross basis | visible, with the gross basis recorded | none | GAP-07 / GAP-16 | WP-09 |
| PAYSLIP | professionalTax (IN) | C | N | event | column | payslip details | none | GAP-07 | WP-09 |
| PAYSLIP | employerRetirementContribution | C (never income) | Y ("evidence only", panel :888-893) | event | 0091:140; excluded from allow-list (0120:54); FDH-12 matching (retirementStatementProcessingService.ts:1017) | unchanged + visible after apply | RT evidence | No (ALREADY CLOSED) | WP-09 details view only |
| PAYSLIP | employeeRetirementContribution | C | N | event | column | payslip details | none | GAP-07 | WP-09 |
| PAYSLIP | employer/employeeNpsContribution (IN) | C (never income) | N | event | columns | payslip details | none | GAP-07 | WP-09 |
| PAYSLIP | netPay | A | Y | proposal | net_amount only when no variable pay (incomeAdapter.ts:262-266); DB uses net_amount ?? amount (dashboard.ts:652-655), so null becomes gross; bank-match key | null = unknown, never gross | DB* (overstated net) | GAP-09 | WP-02 / WP-03 |
| PAYSLIP | ytdGross / ytdTax / ytdNet / ytdEmployerRetirement / ytdEmployeeRetirement | C (never summed) | N | event | 0091:148-153; not selected; not extracted by AI (schema.ts:94-115) | payslip details under "Year to date" | none | GAP-07 | WP-09 |
| PAYSLIP | components[] (side/type/label/amount/is_year_to_date) | C | N | event | fdh_payroll_components (0091:255-289); returned by GET, never rendered | payslip details | none | GAP-07 | WP-09 |
| PAYSLIP | parserName / parserVersion / extractionConfidence / warnings | D | P | event | columns; warnings drive review_status (:707-714) | unchanged | — | No | — |
| PAYSLIP | reconciliation_status / variance | D (visible) | Y | event | 0091:166-168 | unchanged | — | No | — |
| PAYSLIP | bank_match_status / bank_match_transaction_id / bank_match_confidence | D + dedup link | P (status only) | event | 0091:176-180; unique (0091:235-237); transaction id read by nothing; one-shot at processing, no approval filter (payslipProcessingService.ts:252-270) | income read model's payslip↔bank dedupe key; re-matched after bank approval | DB* (double count) | GAP-01 / GAP-10 | WP-02 dedupe; WP-09 restamp RPC (0210) + post-approval matcher |
| PAYSLIP | payslip_fingerprint | D | N | event | unique per user (0091:227-229) | unchanged | — | No | — |
| PAYSLIP | superseded_by_payroll_event_id | D | N | event | column exists (0091:193), never written | supersede RPC + "revised payslip" label | — | GAP-15 | WP-09 (0210) |
| PAYSLIP | approval_status / approved_at / approved_by | D | Y | event | approve RPC (0091:1381-1408); approves without resolving review_status | require review resolved or explicit acknowledgement | — | minor (GAP-07 note) | WP-09 |
| PAYSLIP | proposal summary / reviewReasons / reason_code (incomeAdapter.ts:342-391) | C | N | proposal | discarded by persistProposal (supabaseStore.ts:245-258) | fhip_import_proposals.summary (0207), rendered | — | GAP-07 | WP-09 |
| PAYSLIP | AI-fallback facts (lib/aie/adapters/payslip/schema.ts:94-115; currency derived from country, payslipProcessingService.ts:539) | as native fields; YTD = E (not extracted) | Y | AI draft → event | persistPayrollEvidence (same path) | registry entries per schema key | same | GAP-13 | WP-00 registry; WP-09 |
| PAYSLIP | payslip uploaded via the generic hub (FdhDocumentUploadClient.tsx:23,84) | E / route | N | none | stranded; no process call; excluded from waitingImports (waitingImports.ts:19) | routed to the Income panel, or explicit "not processed here" | — | GAP-11 / UPL-03 | WP-08 (hub page); WP-09 (resume stages) |
| PAYSLIP | re-generated proposal after apply (incomeProposalService.ts:114-162) | D | N | proposal | a new 'ready' proposal; null employer gives add_new → duplicate row | 409 ALREADY_APPLIED per payroll event + partial unique index | IT, DB* | GAP-04 | WP-09 (0210) |
| BANK-INCOME | approved salary credit (economic_transaction_type='income') | B (deduped) | Y (bank review) | fdh_transactions | summed for the current month into gross and net (dashboardData.ts:33,214-224); not on IT; not in TW (twinData.ts:255-288) | selectIncome actual; one event with the matched payslip; IT "Actual income" section | DB*, ACT | GAP-01 / GAP-02 / GAP-06 | WP-02, WP-03, WP-05, WP-09 |

## 3. LIABILITY statements — credit card / loan (FDH-10). MANDATORY GATE. Liabilities → Import Statement (liabilities/page.tsx:42-63)

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| LIAB | activity PURCHASE (card) | B | P (total only, panel :1247-1248) | stmt+proposal | fdh_liability_statement_activities only (service :636-652); purchases_total (:520) | fdh_transactions debit on the card facility account, 'expense', R8-categorised; activities.ledger_transaction_id | none → household expense $0 | G1 / DC-07 | WP-11 (0209) |
| LIAB | activity REFUND (card) | B | P | stmt+proposal | activities; refunds_total (:543) | facility credit, 'refund'; optional refund_original link | none | G1 | WP-11 |
| LIAB | activity PAYMENT (card repayment) | B | Y (label, panel :1292-1300) | stmt+proposal | activities; linked_transaction_id set at extraction (:617-634,648-649); the bank side's open credit_card_settlement link (transferMatching.ts:153-169) is never resolved | facility credit 'transfer' + CONFIRMED credit_card_settlement link from the bank debit; bank debit reclassified to 'transfer'; expense $0 | none | G1 / G4 | WP-11 (link + reclassify); WP-10 (matching quality) |
| LIAB | activity CASH_ADVANCE (card) / 'redraw' (auLoan.ts:41) | B | P (card total; loan none) | stmt+proposal | activities; cash_advances_total (:521); ignored by loan reconciliation (:560-568); loan correction forbids it (0186:299-303) | facility debit 'cash_withdrawal' (not consumption) | none | G1 / G5 | WP-11 ledger; WP-10 totals |
| LIAB | activity INTEREST | B | P | stmt+proposal | activities; interest_total (:538-539) | facility debit 'debt_interest' (cost of debt; debt-service rule D-09) | none | G1 | WP-11 |
| LIAB | activity FEE (annual/late/GST line; loan processing/foreclosure/prepayment) | B | P | stmt+proposal | activities; fees_total (:540-541) | facility debit 'fee' | none | G1 | WP-11 |
| LIAB | activity PRINCIPAL (standalone) | B | N | stmt+proposal | activity only; NOT summed (principal_repayments_total counts components only, :545) | loan credit 'debt_principal'; summed into principal_repayments_total | none | G1 / G5 | WP-11; WP-10 |
| LIAB | activity LOAN_ADVANCE (drawdown) | B | N (drawdowns_total not displayed, panel :1264-1280) | stmt+proposal | activities; drawdowns_total (:544) | loan debit 'transfer' (never income); displayed | none | G1 / G7 | WP-11 |
| LIAB | activity ADJUSTMENT / OTHER | must be resolved by the user, else E | N | stmt+proposal | activity only; adjustments_total never written; reconciliation gets null (:556,565) | Apply blocked until resolved; signed sum into adjustments_total | none | G5 / G1 | WP-10 totals; WP-11 blocking + display |
| LIAB | loan PAYMENT principal/interest/fee components | B (allocations) | P (loan totals, panel :1270-1275) | stmt+proposal | activity columns (0096:271-273) → totals; decomposeLoanPayment (repaymentDecomposition.ts:288-343) called only by tests | loan-leg header + allocations seq1 debt_principal $1,550 / seq2 debt_interest $430 / seq3 fee $20 = $2,000 (0076:124-129 guard); bank leg 'transfer' + loan_payment link; component_mismatch / insufficient_evidence block Apply | none → expense $0 | G1 / G2 | WP-11 |
| LIAB | activity description_raw / merchant_raw / activity_date / amount / currency_code / source_row_number | B attrs + C | N | stmt+proposal | activity columns | copied onto the ledger row; the activity keeps them as evidence | none | G1 | WP-11 |
| LIAB | activity merchant_id / category_id | D / B | N | stmt | columns exist (0096:264-265), never written | category lives on the ledger row (R8 category only, never economic type) | none | G1 | WP-11 |
| LIAB | activity gstAmountRaw (IN card) | C (never summed) | N | stmt | extracted (csvExtraction.ts:200-202; types.ts:104) then DROPPED | activities.gst_amount_raw (0207), shown | none | G6 | WP-10 persist; WP-11 display |
| LIAB | activity bank_match_status / linked_transaction_id | D (source of the B link) | P | stmt | set at extraction (:618-634); no currency/approval/dedup filter, limit 100 unordered (:193-229); no unique index (0096:296-300); multiple_candidates has no picker | filtered candidates; unique partial index; re-verified under lock at Apply; back-match after bank approval; candidate picker | — | G4 | WP-10 (filters + index); WP-11 (Apply verify, back-match, picker) |
| LIAB | header closing_balance (card) / closing_principal (loan) | A | Y | proposal | liabilities.balance (liabilityAdapter.ts:288-293; 0096:947-954) | unchanged (a statement snapshot; ledger rows never mutate it) + provenance badge | LT, NW, DB* | G7 (badge) | WP-07 badge |
| LIAB | header interest_rate | A (loan) / C (card APR) | Y | proposal | loan only (liabilityAdapter.ts:296-298) | card APR shown in statement details | LT, DB* | G7 | WP-11 history |
| LIAB | header minimum_payment (card) | A (liabilities.minimum_payment); monthly_repayment only with explicit confirmation | Y | proposal | minimum_payment (:313-315) and monthly_repayment requiresConfirmation (:301-307), which update_existing applies silently (0096:840; panel :882) | never written to monthly_repayment without a tick; grid column | CF (debt service) | X-01 / G9 / G7 | WP-11 (0209 default selection); WP-07 column; D-08 |
| LIAB | loan payments_total → monthly_repayment | A (planned debt service) | Y | proposal | liabilityProposalService.ts:68 | unchanged; combined with actuals by the debt-service rule | CF, DB* | G9 | WP-02 / WP-03 |
| LIAB | header credit_limit | A (not in NW) | Y | proposal | liabilities.credit_limit (:310-312) | unchanged | LT | No | — |
| LIAB | header due_date | A | Y | proposal | liabilities.due_date (:316-318) | grid column | none visible | G7 | WP-07 |
| LIAB | header masked_identifier | A / D | Y | proposal | liabilities.masked_identifier (:283-285) | grid column | none visible | G7 | WP-07 |
| LIAB | header institution_name | A | Y | proposal | lender + liability_name suffix (:274,280-282) | unchanged | LT | No | — |
| LIAB | header currency_code / country_code / facility_type→debt_type | A | Y | proposal | add_new only (:272-278); USD accepted (primitives.ts:22) and bypasses the AUD/INR schema | refuse unsupported currency with a visible E | NW, DB* (USD added raw) | G13 | WP-11 (0209) |
| LIAB | header opening_balance / opening_principal / statement_period_start/end / statement_date | C | Y | stmt | statement row (:579-588) | statement-history drawer after Apply | none after apply | G7 | WP-11 |
| LIAB | totals purchases / cash_advances / interest / fees / payments / refunds / drawdowns / principal_repayments | C (must equal the sum of B events) | P | stmt | statement row (:590-597) | invariant: totals = ledger sums per type | — | G5 / G7 | WP-10 totals; WP-11 invariant test |
| LIAB | adjustments_total / capitalised_total | C | N | stmt | never written by persist (:556,563-565); correction only (0186:282-285) | computed and shown | — | G5 | WP-10 |
| LIAB | available_credit / rate_type / repayment_frequency / maturity_date / arrears_amount; liabilities.available_credit / arrears_status | E (unsupported, explained) | P ("Not shown on statement") | stmt | columns exist (0096:115-119,171,177-180), never populated; repayment_frequency read but always null (liabilityProposalService.ts:69) | registry E with user copy | — | G6 | WP-10 registry |
| LIAB | reconciliation_status / variance / parser_* / extraction_confidence / review_status / user_corrected_fields | D (reconciliation visible) | Y | stmt | statement row (:598-603; 0186:106-113) | unchanged + history drawer | — | No | — |
| LIAB | extraction warnings (unrecognised type, unparseable date/amount, AI warnings) | E (visible) | N | stmt | only flip review_status (:603); excluded rows invisible (csvExtraction.ts:157-173) | fdh_liability_statements.extraction_warnings (0207), rendered | — | G6 | WP-10 persist; WP-11 render |
| LIAB | statement.liability_id / financial_account_id / household_id | D (provenance) | N | stmt | never set | set by the Apply RPC | — | G7 | WP-11 |
| LIAB | owner (self/spouse) | A (user-selected) | N | proposal | hard-coded 'self' (0096:948-949) | owner selector, validated in the RPC | LT, NW, DB* | G8 | WP-11 |
| LIAB | evidence persist (statement + activities + status) | D | — | ingest | N+2 separate calls; orphan statement; queued→extracted forbidden by 0076:258-270 and the error ignored (:656-661); a second statement on retry (maybeSingle :1160-1169) | one SECURITY INVOKER RPC + one statement per document | review/approve 404 | G3 | WP-10 (0208, forward port of unmerged 24281b8/0198) |
| LIAB | "Keep existing" decision | E / B | Y | proposal | dismisses the whole statement (0096:817-825); activities get no disposition | the ledger still runs; separate "reject statement" (E with reason) | — | G10 | WP-11 |
| LIAB | concurrent proposal generation | D | — | proposal | supersede + insert + fields non-atomic; no unique index (supabaseStore.ts:361-401) | partial unique index (ready/applied) + 23505 handling | — | G11 | WP-11 (0209) |
| LIAB | Apply audit event | D | — | proposal | outside the RPC, document_id null (apply/route.ts:46-53) | inside the RPC with statement_upload_id | — | G12 | WP-11 |
| LIAB | certified economics functions (planCardStatementLedgerWrites, classifyStatementActivity, classifyCashAdvance, decomposeLoanPayment, classifyLoanAdvance) | D | — | — | test-only callers | SQL mapping parity-tested against them | — | G2 | WP-11 |

## 4. AU investment statements (FDH-11) and India CAS (Investment Intelligence)

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| AUINV | statement.statement_type | C | P | stmt | from the user-declared csvKind (service :448,505) | import-history view | none | INV-G9 | WP-12 |
| AUINV | statement.institution_name | A (via ii_accounts) | Y | stmt | account-match input (account-match/route.ts:67); ii_accounts.institution_name on confirm_new (auAccountResolution.ts:106) | unchanged | IIS | No | — |
| AUINV | statement.masked_account_identifier | A (via ii_accounts) | Y | stmt | ii_accounts.account_number_masked only via API-only confirm_new (:109) | "Add as new account" UI | IIS | INV-G3 | WP-12 |
| AUINV | statement.nickname | D / E | N | stmt | column (0106:139), never set | registry E | — | No | WP-12 registry |
| AUINV | statement.base_currency | A | Y | stmt | ii_accounts.currency_code on confirm_new | unchanged | IIS | No | — |
| AUINV | statement_date / start / end | C | P | stmt | statement only (:509-511), from upload metadata | import history | none | INV-G9 | WP-12 |
| AUINV | opening / closing_portfolio_value | C (reconciliation input) | N | stmt | never populated (csvExtraction.ts:181-199,286-301; AI forced undefined :792-794) | extracted where printed; feeds reconcileAuHoldings | — | INV-G8 | WP-12 |
| AUINV | cash_balance (broker cash) | A (PO D-11) or E | N | stmt | never populated; no home (ii_transactions.instrument_id NOT NULL, applyAuStatementActivity.ts:64-71) | per D-11; until then visible E | NW missing it | INV-G8 | WP-12 |
| AUINV | parser / parser_version / extraction_confidence / extraction_status | D | P | stmt | statement | unchanged | — | No | — |
| AUINV | reconciliation_status | D (visible) | N | stmt | stays 'insufficient_data' (0106:157-158); reconcileAuHoldings / reconcileAuBrokerCash have no caller | computed at persist | — | INV-G6 / INV-G8 | WP-12 |
| AUINV | extraction warnings (dropped rows) | E (visible) | N | stmt | not persisted (:500-521); failed inserts swallowed (:534-535,547-548) | fdh_investment_statements.extraction_warnings (0207); throw on insert error | — | INV-G6 | WP-12 |
| AUINV | canonical_account_id | D | — | stmt | auAccountResolution.ts:67,84 | unchanged | — | No | — |
| AUINV | duplicate_of_statement_id / supersedes_statement_id | D | — | stmt | never written; identicalUpload dedup (:320-326) | unchanged | — | No | — |
| AUINV | account owner (self/spouse) | A | N | account | owner_member_id null (auAccountResolution.ts:77-87,94-117,110); blocks publication (publicationLogic.ts:193-195) | owner picker required on confirm_new | NW | INV-G10 | WP-12 |
| AUINV | position.security_name_raw | A (via ii_instruments) | Y | stmt | ii_instruments.instrument_name only via API-only confirm_new_security (security-match/route.ts:46-58) | "Create security" UI | IIS | INV-G3 | WP-12 |
| AUINV | position.ticker_raw / isin / exchange | A (via identifiers) | Y | stmt | match inputs (auSecurityResolution.ts:23-45); exchange defaults 'ASX' (route :63) | unchanged | IIS | No | — |
| AUINV | position.quantity | A (holding) | Y | stmt | would go to ii_holding_snapshots.units (applyAuStatementPosition.ts:91), unreachable: default apply_status 'not_applicable' (0106:226-227) vs route selecting 'pending' (apply/route.ts:35) | positions reach apply | INV, NW: none | INV-G2 | WP-12 (0213 backfill + insert 'pending') |
| AUINV | position.unit_price | A / C | Y | stmt | dropped | ii_holding_snapshots.source_nav + price_source='statement_price' (0040:102; 0092:117) | IIS | INV-G7 | WP-12 |
| AUINV | position.market_value | A | Y | stmt | ii_holding_snapshots.value; null written as '0' (applyAuStatementPosition.ts:92) | null refused/flagged, never 0 | NW (after publish) | INV-G7 | WP-12 |
| AUINV | position.currency_code | A | Y | stmt | ii_holding_snapshots.currency_code | unchanged | IIS | No | — |
| AUINV | position.valuation_date | A | Y | stmt | as_of_date, raw unparsed (csvExtraction.ts:277); insert failure swallowed | parsed with inferDateFormat; errors surfaced | IIS | INV-G6 | WP-12 |
| AUINV | position match/apply metadata (security_match_status, matched_instrument_id, apply_status, canonical_holding_snapshot_id, applied_at/by, source_row_number) | D | — | stmt | positions table | unchanged | — | No | — |
| AUINV | activity BUY | B (II ledger); household expense 0 | Y | stmt+apply | ii_transactions 'purchase' (applyAuStatementActivity.ts:53) | + holdings published + bank funding leg corroborated ('investment') | IIS | INV-G1 / INV-G4 | WP-12 |
| AUINV | activity SELL | B; ordinary income 0 | Y | stmt+apply | ii_transactions 'sale' (:54) | + bank proceeds leg reclassified out of income | IIS | INV-G4 | WP-12 |
| AUINV | activity DIVIDEND | B; one event with the bank credit | Y | stmt+apply | ii_transactions 'dividend' (:55) | bank credit is the single household-income leg; the broker leg is corroboration only | IIS | INV-G4 | WP-12 + WP-02 income selector |
| AUINV | activity DISTRIBUTION | B | Y | stmt+apply | 'dividend' (:58), lossy | distinct subtype | IIS | INV-G7 | WP-12 |
| AUINV | activity DRP | B | Y | stmt+apply | 'reinvestment' (:59) | unchanged | IIS | No | — |
| AUINV | activity TRANSFER_IN / TRANSFER_OUT | B | Y | stmt+apply | transfer_in / transfer_out (:60-61) | unchanged | IIS | No | — |
| AUINV | activity BROKERAGE / FEE | B | Y | stmt+apply | 'fee' (:62-63) | unchanged | IIS | No | — |
| AUINV | activity INTEREST / CASH_DEPOSIT / CASH_WITHDRAWAL | B (broker cash, D-11) or E visible | Y | stmt+apply | 'skipped' (:69-71,131-139); unresolvable in the UI, so any statement containing them cannot be approved (panel :487) | excluded from unresolvedCount; target per D-11; skip reason shown | none | INV-G3 / INV-G8 / INV-G9 | WP-12 |
| AUINV | activity CORPORATE_ACTION_EVIDENCE / OTHER / UNKNOWN | E visible or review | Y | stmt+apply | skipped (:73-75), reason never shown | reason shown | none | INV-G9 | WP-12 |
| AUINV | activity.trade_date | B | Y | stmt+apply | ii_transactions.transaction_date (:198) | unchanged | IIS | No | — |
| AUINV | activity.settlement_date | C | N | stmt | fallback only; otherwise never shown | import history | none | INV-G7 / INV-G9 | WP-12 |
| AUINV | activity.security_name_raw / ticker_raw / isin | A (via instruments) | Y | stmt | match inputs | unchanged | — | No | — |
| AUINV | activity.quantity / unit_price / amount / currency_code | B | Y | stmt+apply | units / price_per_unit / gross_amount / currency_code (:195,199-201) | unchanged | IIS | No | — |
| AUINV | activity.description_raw | C / B meta | P | stmt | evidence only (csvExtraction.ts:173) | ii_transactions.source_description (0040:40) | — | INV-G7 | WP-12 |
| AUINV | activity.brokerage_raw | B (ii_transactions.fees) | P | stmt | dropped at apply; raw string into a numeric column breaks the insert (csvExtraction.ts:174; service :547-548) | parsed into fees | IIS cost base | INV-G6 / INV-G7 | WP-12 |
| AUINV | activity.franking_credit_raw / withholding_tax_raw | C (tax), visible | N | stmt | never extracted (DEFAULT_TRANSACTION_COLUMN_MAP :182-185; AI :823-824) | mapped; withholding into ii_transactions.taxes | — | INV-G7 | WP-12 |
| AUINV | activity.linked_transaction_id / bank_match_status / bank_match_candidates | B link | P | stmt | evidence only (:919-922); matcher forces institutionOrNarrativeMatches=true (:907), ignores direction/currency/approval | a real signal; on apply the bank leg is corroborated and reclassified | DB (bank leg) | INV-G4 | WP-12 |
| AUINV | activity apply metadata (apply_status, canonical_transaction_id, applied_at/by, apply_rejected_reason, review_status, source_row_number) | D | — | stmt | activities | reason rendered | — | INV-G9 | WP-12 |
| AUINV | ii_transactions / ii_holding_snapshots provenance | D | — | apply | source_document_id null; no ii_transaction_source_links; fingerprint sourceReference null collapses identical same-day trades (applyAuStatementActivity.ts:165-175) | FDH provenance + source_row in the fingerprint | IIS | INV-G7 | WP-12 |
| AUINV | publication into `investments` | A (NW projection) | N | — | never happens: no recertifyPosition call, owner null, /investment-intelligence/data cannot list FDH-11 snapshots (source-documents/[id]/summary/route.ts:25-34) | recertify + publish step inside the AU panel (D-05); an "Imported, not yet in Net Worth" bucket until then | NW, DB*, FC, TW, RP | INV-G1 / DC-08 | WP-12; WP-02 selectInvestments |
| AUINV | position apply cross-tenant (no FOREIGN_ACCOUNT check, applyAuStatementPosition.ts:55-56; BEFORE UPDATE-only triggers 0106:471-473,504-506) | security | — | — | PLAUSIBLE forged INSERT → a write into another user's account | owner check + BEFORE INSERT triggers + same-tenant triggers on ii_holding_snapshots/ii_transactions | — | INV-G5 | WP-12 (0213) |
| AUINV | AI fallback (40-row cap, schema.ts:82-83; flag default OFF) | E (visible) | Y | AI draft | warned via allRowsListed | blocking when truncated | — | INV-G11 | WP-12 |
| AUINV | current-vs-statement comparison (currentVsStatement.ts:27-45) | D | N | — | unpaginated; never called by the UI | paged; shown before Apply | — | INV-G11 | WP-12 |
| IICAS | all CAS fields | A / B | Y | process + certify + publish | ii_* (documentProcessing.ts:160,1014,1055,1556) → investments (investmentPublicationService.ts:517,574), label "Imported via Investment Intelligence" (FinancialDataGrid.tsx:920,1142) | unchanged | INV, NW, IIS, RP | No (ALREADY CLOSED) | WP-00 registry iiCas.ts only |
| IICAS | real-scan admission fails open without the 0196 columns (realScanAdmission.ts:92-95,124-129) | security | — | upload | admitted on the structural check only | fail closed (503) when the real-scan flag is on and the columns are missing | — | UPL-02 | WP-12 |

## 5. RETIREMENT / super statements (FDH-12) — Retirement → Import retirement statement (retirement/page.tsx:45)

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| RET | fund_name | A (ADD NEW identity) + C | Y | stmt+proposal | statement (service :755); retirement_accounts.account_name on add_new (retirementAdapter.ts:321-324) | unchanged + history | RT | No | — |
| RET | masked_account_identifier / member number | C | Y | stmt | statement (:756); CHECK rejects 7+ digit runs (0112:368-369) | statement history | none after apply | GAP-RET-03 | WP-13 |
| RET | account_type | A (add_new) / D | Y | proposal | EVIDENCE_TO_CANONICAL_ACCOUNT_TYPE (adapter :95-109,325) | unchanged | RT | No | — |
| RET | statement_type / retirement_jurisdiction / parser / parser_version / extraction_confidence / source_provenance | D | P | stmt | statement (:752-753,777-779,788); jurisdiction → country_code on add_new | unchanged | — | No | — |
| RET | currency_code | A | Y | proposal | derived from jurisdiction (panel :375); a hard match filter (adapter :212) | unchanged | NW (converted) | No | — |
| RET | statement_date / statement_start_date / statement_end_date | C + balance as-of | P (period only; statement_date never) | stmt | statement only (:758-760); no as-of on the canonical balance | as-of carried with the balance; an older statement cannot silently regress it | RT, NW | GAP-RET-06 / GAP-RET-03 | WP-13 |
| RET | opening_balance | C | Y | stmt | statement (:761) | history | none after apply | GAP-RET-03 | WP-13 |
| RET | closing_balance | A | Y | proposal | retirement_accounts.current_balance (adapter :342-349; 0119); absent → no proposal (never $0) | unchanged + provenance badge | NW, DB*, FC, TW, GO | GAP-RET-08 (badge) | WP-07 |
| RET | employer_contributions (period total) | C by default; A only with an explicit rate + frequency (D-12) | Y | proposal | proposal field (adapter :355-361, requiresConfirmation) applied silently by update_existing (panel :550,578-580; 0112:1322-1323; 0119:147-148); read as a monthly rate (dashboard.ts:1062-1069) | never applied unticked; always paired with a frequency | DB contribution rate, FC, GO (≈12x inflation) | GAP-RET-01 / GAP-RET-02 / X-01 | WP-13 (0211); WP-03 / WP-05 null-frequency handling |
| RET | personal_contributions (period total) | same as employer | Y | proposal | same (adapter :362-368) | same | same | GAP-RET-01 / GAP-RET-02 | WP-13 |
| RET | contribution_frequency | A (paired) | N | proposal | adapter supports it (:369-375), never set by proposal/route.ts:88-104 | derived from the period, or annualised | DB*, FC | GAP-RET-02 | WP-13 |
| RET | salary_sacrifice | C | N (not rendered, panel :74-102,947-959) | stmt | statement (:765) | rendered in review + history | none | GAP-RET-04 / GAP-RET-03 | WP-13 |
| RET | government_contributions | C | N | stmt | statement (:766) | rendered | none | GAP-RET-04 | WP-13 |
| RET | rollovers_in | C (neutral) | N (header); activity rows P | stmt | statement (:767); pairing only (:1188-1256) | rendered + pairing status | none | GAP-RET-04 | WP-13 |
| RET | rollovers_out | C (neutral) | N | stmt | statement (:768) | rendered | none | GAP-RET-04 | WP-13 |
| RET | withdrawals | C; the bank credit is transfer/retirement income | N | stmt | statement (:769); bank-matched but not reclassified | rendered; linked bank leg reclassified with the user's confirmation | DB (bank leg may count as income) | GAP-RET-04 / GAP-RET-07 | WP-13 |
| RET | pension_payments | C; household income via the bank credit, once | N | stmt | statement (:770) | rendered; bank leg counted once | DB* | GAP-RET-04 / GAP-RET-07 | WP-13 |
| RET | investment_earnings | C | Y | stmt | statement (:771) | history | none | GAP-RET-03 | WP-13 |
| RET | fees | C (never a household expense) | Y | stmt | statement (:772); summary layout overwrites repeated lines (extraction.ts:337-338) | summed + history | none | GAP-RET-05 / GAP-RET-03 | WP-13 |
| RET | insurance_premiums | C | Y | stmt | statement (:773) | history | none | GAP-RET-03 | WP-13 |
| RET | tax | C | Y | stmt | statement (:774) | history | none | GAP-RET-03 | WP-13 |
| RET | ytd_employer_contributions / ytd_personal_contributions | C (labelled YTD) | N | stmt | statement (:775-776) | rendered | none | GAP-RET-04 | WP-13 |
| RET | activities[]: EMPLOYER_CONTRIBUTION, PERSONAL_CONTRIBUTION, SALARY_SACRIFICE, GOVERNMENT_CONTRIBUTION, ROLLOVER_IN, ROLLOVER_OUT, INVESTMENT_EARNINGS, INTEREST, DISTRIBUTION, FEE, INSURANCE_PREMIUM, TAX, PENSION_PAYMENT, WITHDRAWAL, ADJUSTMENT, OTHER, UNKNOWN (+ activity_date, effective_period_start/end, amount, currency_code, description_raw, employer_name_raw, is_summary_total, is_year_to_date, source_row_number) | C (contribution history), never posted | P (date/type/amount/payslip match only) | stmt | fdh_retirement_statement_activities (:838-856); payslip link unique (0112:534-536); bank link unique (0112:540-542) | persistent contribution history with all columns | none after apply | GAP-RET-03 / GAP-RET-04 | WP-13 |
| RET | PERSONAL_CONTRIBUTION matched bank debit | B (bank leg = transfer) | N | stmt | linked only (service :1159-1168); the bank debit can stay 'expense' | bank leg reclassified to 'transfer' with the user's confirmation | DB (expense counted while the fund balance rises) | GAP-RET-07 | WP-13 (0207 helper) |
| RET | positions[] (option_name_raw, asset_class_raw, ticker_raw, isin, units, unit_price, market_value, currency_code, valuation_date) | C (excluded from NW) | P (name + value only, panel :1062-1077) | stmt | fdh_retirement_statement_positions (:864-880), terminal | "holdings in super" view with all columns | none (correctly not NW) | GAP-RET-03 / GAP-RET-04 | WP-13 |
| RET | warnings[] (unreadable_amount_rows_skipped, unreadable_date_rows, unclassified_activity_rows, unreadable_summary_rows_skipped, unreadable_holding_rows_skipped, date_format_not_inferable) | C / E (visible) | N | stmt | dropped (service :736-916) | extraction_warnings (0207), rendered | — | GAP-RET-05 | WP-13 |
| RET | unrecognised summary-layout rows | E (visible) | N | stmt | silently skipped (extraction.ts:317-318) | counted as warnings / 'other' lines | — | GAP-RET-05 | WP-13 |
| RET | failed activity / position inserts | E | N | stmt | swallowed (:856-857,879-880) | extraction_failed | — | GAP-RET-05 | WP-13 |
| RET | reconciliation_status / variance / account_match_* / smsf_classification / smsf_evidence / approval_* / duplicate_of / supersedes | D | Y (balance check) | stmt | UPDATE-guarded (0112:782-834); INSERT forgeable (RLS insert own 0112:395,547,599; triggers BEFORE UPDATE only) | BEFORE INSERT guard / drop authenticated INSERT | provenance forgeable | GAP-RET-09 | WP-13 (0211) |
| RET | member (retirement_member_id) | A | Y | proposal | stamped on add_new (0119:269-272); MEMBER_MISMATCH (0119:189-192), which collapses to WRITE_FAILED/400 (applyRetirementProposalAtomic.ts:49-59,78-84) | refusal code mapped to 409 | — | GAP-RET-11 | WP-13 |
| RET | PDF super statements | E (visible) | Y (message) | — | refused (service :103-104; panel :752) | unchanged (PO may later route to AIE) | — | GAP-RET-12 (disclosed) | none |
| RET | imported-row provenance label | D | — | — | source_type='retirement_statement_import' stamped (0112:1475-1479); grid ignores it (FinancialDataGrid.tsx:49,100-105) | badge linking to history | RT | GAP-RET-08 | WP-07 |

## 6. INSURANCE and other AIE uploads — ACTIVE USER FLOW: NO

No UI caller of /api/aie/insurance/intake. Flags unset in production (register :32-37,102). Every row is latent: it is recorded in the registry as `not_active` and is not certified.

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| INS | policyName | A | (inactive) | AIE accept | insurance_policies.policy_name (write.ts:129) | same | DB, RES, TW, RP | No | — |
| INS | coverType | A + C raw label | (inactive) | AIE accept | normalised enum; TPD/trauma become 'other', raw lost (parser.ts:75-83,214-215) | coverTypeRaw evidence | same | INS-05 (latent) | not active |
| INS | coverAmount | A | (inactive) | AIE accept | cover_amount; multi-component blocks | same | same | No | — |
| INS | premium | A (display only, dashboard.ts:1086-1098) | (inactive) | AIE accept | premium | same | same | No | — |
| INS | premiumFrequency | A | (inactive) | AIE accept | premium_frequency | same | same | No | — |
| INS | currencyCode | A | (inactive) | AIE accept | currency_code; non-AUD/INR fails | same | same | No | — |
| INS | renewalDate | A | (inactive) | AIE accept | ISO date or blocking unreadable fact | same | same | No | — |
| INS | waitingPeriodDays | A | (inactive) | AIE accept | extractInt: "4 weeks" becomes 4 days (parser.ts:124-127,253-255) | unit-aware | same | INS-01 (latent) | not active |
| INS | benefitPeriod | A | (inactive) | AIE accept | raw string | same | same | No | — |
| INS | provider | A | (inactive) | AIE accept | provider | same | same | No | — |
| INS | owner (household role) | A (user) | (inactive) | AIE accept | from the caller (write.ts:139) | same | same | No | — |
| INS | master_item_key (renewal lineage) | D | (inactive) | AIE accept | never sent (RunReviewPanel.tsx:188), so every accept inserts a duplicate (registry.ts:42-46) | "update existing policy" | cover double-counted | INS-02 (latent) | not active |
| INS | country_code | A | (inactive) | AIE accept | not set (write.ts:128-142) | derived | — | INS-04 (latent) | not active |
| INS | notes | D | (inactive) | AIE accept | caller-supplied | same | — | No | — |
| INS | documentSubClass | C / E | (inactive) | AIE accept | aie_field_candidate | same | — | No | — |
| INS | policyNumberMasked | C | (inactive) | AIE accept | candidate only; aie_insurance_adapter_link never read | import-details view | — | INS-03 (latent) | not active |
| INS | policyOwnerName | C | (inactive) | AIE accept | candidate only | details view | — | INS-03 | not active |
| INS | insuredPersonName | C | (inactive) | AIE accept | candidate only | details view | — | INS-03 | not active |
| INS | beneficiaryName | C | (inactive) | AIE accept | candidate only | details view | — | INS-03 | not active |
| INS | excessAmount | C | (inactive) | AIE accept | candidate only | details view | — | INS-03 | not active |
| INS | exclusionsText | C | (inactive) | AIE accept | candidate only | details view | — | INS-03 | not active |
| INS | printedAnnualPremiumTotal | C / reconciliation | (inactive) | AIE accept | cross-check (reconciliation.ts:108-129) | same | — | No | — |
| INS | multiComponentPolicyDetected | E | (inactive) | AIE accept | blocks | same | — | No | — |
| INS | unreadablePrintedFactCount / Evidence | E | (inactive) | AIE accept | blocks | same | — | No | — |
| INS | unrecognised non-money labelled lines | E / C | (inactive) | AIE accept | silently skipped (parser.ts:178-195) | low-severity evidence | — | INS-05 (latent) | not active |
| INS | policy write + link atomicity | D | (inactive) | AIE accept | non-atomic (write.ts:163-173) | one RPC | — | INS-06 (latent) | not active |
| INS | disposition registry | D | — | — | none | registry entries (status not_active) + inactive-flow guard test | — | INS-07 / INS-00 | WP-00 |
| AIE | /api/aie/intake (diagnostic; Apply refused, accept.ts:260) | E | — | — | no UI | ACTIVE USER FLOW: NO | — | — | not active |
| AIE | /api/aie/fdh-bank/intake (flag off, no UI) | B via atomic import | — | — | no UI | ACTIVE USER FLOW: NO | — | — | not active |
| AIE | /api/aie/investment-intelligence/intake (2-email pilot, API only; canonical write flag off) | A/B via II | — | — | no UI | ACTIVE USER FLOW: NO | — | — | not active |

## 7. Upload surfaces (cross-cutting)

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| UPL | payslip / bank PDF extraction wall-clock timeout | E (visible timeout) | — | — | none (bank-pdf/textExtraction.ts:80-94; payslipProcessingService.ts:360); no maxDuration on the payslip process route | bounded timeout → extraction_timeout (error_code widened in 0207); maxDuration | — | UPL-01 (R-14-8 still open) | WP-08 (extractor + bank routes); WP-09 (payslip route) |
| UPL | generic /financial-data-hub upload page (direct URL, production-enabled) | E | — | — | uploads stranded 'queued' with no process/Apply (FdhDocumentUploadClient.tsx:62-116) | retire in prod or route to domain panels (PO D-13) | — | UPL-03 | WP-08 |
| UPL | malware config header comment contradicts the code (config.ts:12-17 vs realScanGate.ts:139-141) | D | — | — | comment wrong, behaviour correct | comment fixed | — | UPL-04 | WP-08 |
| UPL | Admin recommendations CSV | out of scope (reference data) | — | — | admin only | — | — | — | not user data |

## 8. DOWNSTREAM consumers — canonical meanings as read today

| Source | Field/event | Classification | User reviewed? | Approval object | Current destination | Required destination | Downstream consumers | Gap? | Fix |
|---|---|---|---|---|---|---|---|---|---|
| DOWN | Income: Dashboard gross/net monthly income | A + B via selectIncome | — | — | income_sources (dashboardData.ts:130, no currency) + current-month bank income (both gross and net) | selectIncome(basis) with payslip↔bank dedupe, currency, null-net unknown | DB* | DC-01 / DC-02 / GAP-01 / GAP-03 / GAP-09 | WP-02 / WP-03 |
| DOWN | Income: Twin gross income / incomeBand | A + B | — | — | twinData.ts:262 private loader (no superseded flag, no bank) | shared snapshot | TW | DC-04 / GAP-02 | WP-05 |
| DOWN | Income: premium report appendix | A + B | — | — | reportSnapshotResolver.ts:362 (includes superseded rows, no bank, no currency) | selector line items with provenance | RP | DC-10 / GAP-02 | WP-06 |
| DOWN | Income: passive/active, topIncome, source count, largest share, employer concentration | A + B | — | — | manual rows only (dashboard.ts:656-659,781-804); mixed numerator/denominator (:787-790) | selector line items | DB* | DC-02 | WP-03 |
| DOWN | hasIncome / hasExpenses flags | D | — | — | manual rows only (dashboard.ts:1302-1303) | planned OR actual present in the window | SC, DNA, RES, GO, TW, RP eligibility, section status | DC-05 / EXP-G6 | WP-03 |
| DOWN | Expenses planned (expense_items) | A | — | — | dashboardData.ts:132-139; twinData.ts:137,263; reportSnapshotResolver.ts:363-371 | selectExpenses planned | DB*, TW, RP | No | WP-02 (exposes) |
| DOWN | Expenses actual (approved fdh_transactions) | B | — | — | current month only; ignores dedup, allocations, refund links (dashboardData.ts:203-213,266-280) | selectExpenses actual/combined (approvedSummary semantics) | DB* | DC-01 / DC-03 / EXP-G2 | WP-02 / WP-03 |
| DOWN | essential / core survival / emergency-fund months / liquidity / FI ratio | A + B | — | — | manual is_essential only (dashboard.ts:708-717,929,1112,1116); FC :403,:691 | category essential mapping for actuals | DB*, RES, FC | DC-11 / EXP-G6 | WP-02 / WP-03 / WP-05 |
| DOWN | Twin housing_cost_ratio / remittance | A + B | — | — | expense_items master key only (twinData.ts:188-193) | selectExpenses by category group | TW | DC-04 | WP-05 |
| DOWN | Assets | A | — | — | assets.current_value converted (dashboard.ts:816); Twin raw (metricDerivation.ts:147,166,379); appendix without currency (:345) | selectAssets (native + reporting); bank-balance evidence bucket | NW, TW, RP | DC-16 / DC-13 / DC-10 | WP-02 / WP-05 / WP-06 |
| DOWN | Liabilities balance / monthly_repayment | A + B settlement links | — | — | debt service = monthly_repayment (dashboard.ts:743) + bank interest/fee (:735) | selectLiabilities debt-service rule (actual replaces contractual, never both) | CF, DB*, FC, TW, DNA | DC-06 / EXP-G7 / G9 | WP-02 / WP-03 |
| DOWN | Credit-card consumption | B | — | — | none (no ledger rows) | facility-leg purchases in selectExpenses | CF | DC-07 | WP-11 + WP-02 |
| DOWN | Investments | A | — | — | `investments` only (dashboard.ts:817); AU needs a publish that cannot happen; II chapters read ii_* (investmentIntelligenceReportData.ts:21-27) | selectInvestments + unpublished bucket; one portfolio total | NW, FC, TW, RP | DC-08 / INV-G1 | WP-02 / WP-12 / WP-06 |
| DOWN | Retirement | A | — | — | current_balance (dashboard.ts:818); contributions not converted (:1062-1069); null frequency treated as monthly | selectRetirement (converted; null frequency = unknown) | NW, DB*, FC, TW | DC-12 / GAP-RET-02 | WP-02 / WP-03 / WP-05 |
| DOWN | Net Worth | D | — | — | dashboard.ts:853; Twin omits business entities (twinData.ts:255-289) | one computation | DB*, TW, RP | DC-04 | WP-05 |
| DOWN | Cashflow / monthlySurplus / savingsRate | D | — | — | manual + MTD bank − debt service (dashboard.ts:757-763); used as a perpetual contribution (forecastData.ts:922) | combined basis over complete covered months | DB*, FC | DC-01 / DC-02 | WP-03 / WP-05 |
| DOWN | financial_snapshots history | D | — | — | every loadDashboard upsert, errors ignored (dashboardData.ts:308-330); frozen at the last load of the month | written from complete-month selector values; months covered by an applied statement back-filled | SC stability, TW trends | DC-01 / DC-14 | WP-03 |
| DOWN | Report staleness inputs | D | — | — | manual registers only (reportSnapshotResolver.ts:158-166,203-207) | + fdh_transactions.approved_at, allocations, ii_holding_snapshots, ii_fhip_publications, retirement/liability applications | RP | DC-09 | WP-06 |
| DOWN | Currency mixing in the engine | D | — | — | raw sums (dashboard.ts:589-591,651-658,708-722,873,936-1013,1020-1070,1087-1090; healthScore.ts:344) | per-row reporting amounts; unsupported → fail closed + surfaced | DB* | DC-12 | WP-02 / WP-03 |
| DOWN | Currency mixing Twin / forecast goal variance | D | — | — | metricDerivation.ts:135-189,371-381; forecastData.ts:1533-1535 | converted | TW, FC | DC-13 | WP-05 |
| DOWN | error→0 / null→0 coercions | D | — | — | dashboardData.ts:43-50,257,299,302,308-330; twinData.ts:276-284,188-203; financialDnaData.ts:61; resilienceData.ts:78; goalsData.ts:310-338; forecastData.ts:1500-1552; healthScore.ts:142,198-201,223,336 | explicit 'unavailable'; null = missing component | all | DC-14 | WP-03 / WP-04 / WP-05 |
| DOWN | repeated non-atomic loadDashboard per request | D | — | — | healthScoreData.ts:64,70; resilienceData.ts:68; twinData.ts:161-167; reportSnapshotResolver.ts:263-268 | one CanonicalFinancialSnapshot per request | SC, TW, RP | DC-15 | WP-04 (+ WP-05, WP-06) |
| DOWN | unpaginated register reads | D | — | — | twinData.ts:137-144,262-270; financialDnaData.ts:54; forecastData.ts:429-450,504-509,703-707,848-852,1544-1547; goalsData.ts:310-338 | selectors on fetchAllRows | TW, DNA, FC, GO | DC-18 | WP-04 / WP-05 |
| DOWN | direct fdh_* reads outside FDH | D | — | — | dashboardData.ts:205,216,268 only | replaced by lib/read-models | DB | DC-19 | WP-03 |
| DOWN | Expenses tab | UI | — | — | expense_items grid only (expenses/page.tsx:12-17,55) | planned + actual side by side + variance | ET | EXP-G1 / DC-17 | WP-07 |
| DOWN | Income tab | UI | — | — | income_sources grid, no provenance badge, no bank income (income/page.tsx:57; FinancialDataGrid.tsx:104-106) | badge + "Actual income" section | IT | GAP-06 | WP-07 (badge) / WP-09 (section) |

## 9. Architect verification and cross-domain findings (read against a115ee5)

- **X-01 (P1, new, cross-domain).** "Update existing" applies confirmation-gated fields that the user left unticked.
  - The RPCs select every proposal field when p_selected_fields is null: income 0120:113, liability 0096:840, retirement 0119:147-148.
  - All three panels send `undefined` for update_existing: PayslipImportPanel.tsx:603, LiabilityImportPanel.tsx:882, RetirementStatementImportPanel.tsx:578-580.
  - `requires_confirmation` (0091:418) is never checked.
  - Consequences: a card's minimum payment reaches monthly_repayment (liabilityAdapter.ts:304); an unstated income frequency is applied (incomeAdapter.ts:274); retirement period totals are applied as rates.
  - Fixed per domain in 0209, 0210 and 0211.
- **X-02 (design constraint for WP-11).**
  - fdh_transactions refuses authenticated INSERTs (trg_r7_block_authenticated_insert_transactions, 0064:392-405). auth.role() still returns 'authenticated' inside a SECURITY DEFINER RPC.
  - Changing economic_transaction_type / category_id needs a fresh fdh_transaction_corrections row (0068:129-165).
  - The FDH-10 ledger Apply and every bank-leg reclassification must therefore run through the existing `fhip.import_bridge_internal_write` GUC pattern (0096:411,939) and the internal reclassify helper added in 0207, which writes correction evidence.
  - The liability map's plan omitted this.
- **X-03.** fdh_approved_financial_summaries is D-only. It is never read by a downstream consumer; read models compute from rows, so a stale summary cannot leak.
- **Location conflicts.**
  - The registry cannot live under lib/financial-data-hub: tests/unit/fdh1Isolation.test.ts:585-606 forbids any FDH file naming an Input Data register. It goes in lib/canonical-data/disposition/.
  - The three proposed read-model locations are unified in lib/read-models/.
- **Migration numbering.** Every map claimed 0207; numbers are now assigned uniquely, 0207-0213.
  - The branch scan found 0198 on the unmerged fix/fdh10-liability-zero-amount-atomic (24281b8, not an ancestor of a115ee5) and 0199-0202 on fix/nav1-production-completion-2026-09-25. Nothing at or above 0207 is claimed.
  - 0198 is forward-ported as 0208; the branch must not be merged as-is.
  - Shared CHECK widenings (fdh_statement_uploads.error_code, predecessor 0206; fdh_document_audit_events.event_type, predecessor derived from the ledger, latest 0186) happen ONLY in 0207.
- **Severity reconciliation.** DC-03 (P0) and EXP-G4 (P1) share one root: the dedup bypass. It is tracked once, at P0, in WP-02, WP-03 and WP-08.

## 10. Gap register

Every gap id used above, with its severity and the work package(s) that close it. `tests/unit/uploadFieldDispositionRegistry.test.ts` (rule R5) parses this table: every `open_gap` entry in the field-disposition registry must name an id listed here, with the same severity.

| Gap | Severity | Closing WP | Summary |
|---|---|---|---|
| GAP-01 | P0 | WP-02, WP-03, WP-14 | Payslip salary plus the matching bank salary credit is counted TWICE in the Dashboard and in every loadDashboard consumer (Score, DNA, Resilience, Goals, Forecast, Rep... |
| GAP-02 | P1 | WP-05, WP-06 | The Twin uses a divergent private Income loader. |
| GAP-03 | P1 | WP-02, WP-03, WP-09 | Currency is not preserved for Income. |
| GAP-04 | P1 | WP-09 | Idempotency is per PROPOSAL, not per payroll event. |
| GAP-05 | P1 | WP-01, WP-09 | There is no self/spouse attribution for payslips. |
| GAP-06 | P2 | WP-07, WP-09 | The Income tab does not meet the provenance and visibility contract. |
| GAP-07 | P2 | WP-01, WP-09 | Many evidence-only payslip facts are never user-visible, and the proposal explanation is discarded. |
| GAP-08 | P2 | WP-02, WP-09 | Variable pay (bonus, overtime, commission, other earnings/arrears) has no canonical economic effect. |
| GAP-09 | P2 | WP-02, WP-03 | Null net becomes gross. |
| GAP-10 | P2 | WP-09 | Bank matching is a one-shot at payslip processing time. |
| GAP-11 | P2 | WP-08, WP-09 | Payslips can get stranded before Apply. |
| GAP-12 | P3 | WP-09 | semimonthly, irregular and unknown pay frequencies can never be applied as a new Income row. |
| GAP-13 | P2 | WP-00 | There is no field-disposition registry and no CI orphan test for payslip fields. |
| GAP-15 | P3 | WP-09 | Revised-payslip supersession is unimplemented. |
| GAP-16 | P3 | WP-09 | The recurring-gross basis relies on unverified assumptions. |
| EXP-G1 | P0 | WP-07 | The Expenses tab does not show approved imported actuals. |
| EXP-G2 | P0 | WP-02 | There is no canonical Expense read model. |
| EXP-G3 | P1 | WP-03, WP-08 | Approved actuals affect the Dashboard only when transaction_date falls in the CURRENT calendar month. |
| EXP-G4 | P1 | WP-02, WP-03, WP-08 | Duplicate protection bypass. |
| EXP-G5 | P1 | WP-02, WP-03, WP-08 | User splits never reach the Dashboard. |
| EXP-G6 | P1 | WP-03, WP-04 | Several derived figures ignore bank actuals. |
| EXP-G7 | P1 | WP-02, WP-03 | Loan and card interest and fees are double-counted. |
| EXP-G8 | P1 | WP-08 | 1000/1001-row limits in the approval path. |
| EXP-G9 | P2 | WP-02 | Refund handling is inconsistent across three places: the Dashboard nets every approved refund in the month, linked or not; approvedSummary/Activity net only CONFIRMED ... |
| EXP-G10 | P2 | WP-05 | The Twin builds its own Dashboard without bank actuals, without the superseded_by_bank_import column (superseded manual rows are counted there but not on the Dashboard... |
| EXP-G11 | P2 | WP-06 | The Premium report appendix, which says it lists 'every recorded item used in this report's calculations', lists only expense_items, so imported actuals are missing. |
| EXP-G12 | P2 | WP-08 | Post-approval edits bypass approval. |
| EXP-G13 | P2 | WP-01, WP-02, WP-08 | There is no owner/entity on imported accounts or transactions (self vs spouse vs SMSF), so every approved bank actual is added to household cash flow. |
| EXP-G14 | P2 | WP-00, WP-08 | Some fields are silently dropped or not visible, and no field-disposition registry exists. |
| EXP-G15 | P2 | WP-08 | The AI-fallback path caps extraction at 80 rows. |
| EXP-G16 | P2 | WP-02 | Some approved types end up only in fdh_transactions and Activity. |
| EXP-G17 | P3 | WP-08 | Overlapping-statement evidence is computed and then discarded (it never produces a review item or a user-visible note). |
| EXP-G18 | P3 | WP-08 | In the Approved Financial Summary, category_aggregates labels are category UUIDs rather than display names. |
| G1 | P0 | WP-11 | An approved card or loan statement produces NO canonical transaction events. |
| G2 | P1 | WP-11 | The certified economics controls ('the two controls the PO scrutinises most') are dead in production. |
| G3 | P1 | WP-10 | Two related defects in evidence persistence. |
| G4 | P1 | WP-10, WP-11 | Bank repayment matching is too weak to drive a canonical link. |
| G5 | P1 | WP-10 | Statement totals drop activity types, so reconciliation is wrong or vacuous. |
| G6 | P2 | WP-00, WP-01, WP-10, WP-11 | Some extracted fields are silently dropped or never populated. |
| G7 | P1 | WP-07, WP-11 | Imported cards/loans have no provenance or statement visibility in the Liabilities tab. |
| G8 | P2 | WP-11 | Owner is hard-coded to 'self' and household_id is not set on add_new, so a spouse's card or loan becomes self's debt (FDH-15 self≠spouse). |
| G9 | P1 | WP-02, WP-03 | Downstream consumers are not ready for liability ledger events, so wiring G1 alone will mis-count. |
| G10 | P2 | WP-11 | 'Keep existing' dismisses the whole statement. |
| G11 | P2 | WP-11 | Proposal generation is non-atomic and has no single-live guard. |
| G12 | P3 | WP-11 | The Apply audit event is written outside the RPC transaction with documentId null, so provenance cannot be tied to the document and can be lost if the request dies aft... |
| G13 | P3 | WP-11 | PLAUSIBLE: USD statements are accepted (FDH_SUPPORTED_CURRENCIES includes USD), and the RPC can insert a USD liability, bypassing the AUD/INR zod schema. |
| INV-G1 | P0 | WP-12 | AU apply ends in ii_transactions and ii_holding_snapshots and never reaches the Investments tab or Net Worth. |
| INV-G2 | P0 | WP-12 | Position apply can never run. |
| INV-G3 | P0 | WP-12 | UI dead end on account and security matching. |
| INV-G4 | P1 | WP-02, WP-12 | Bank<->broker semantics exist only as unused pure functions and evidence columns. |
| INV-G5 | P1 | WP-12 | PLAUSIBLE cross-tenant write through position apply. |
| INV-G6 | P1 | WP-01, WP-12 | Rows are dropped silently at extraction and persist. |
| INV-G7 | P2 | WP-12 | Fields are lost or distorted at apply. |
| INV-G8 | P2 | WP-12 | Broker cash and statement totals have no canonical home. |
| INV-G9 | P2 | WP-12 | Skipped and unsupported outcomes, and approved statements, are not user-visible after apply. |
| INV-G10 | P2 | WP-12 | FDH-15 self vs spouse: the owner is never captured for AU broker accounts. |
| INV-G11 | P3 | WP-12 | Minor defects. |
| GAP-RET-01 | P1 | WP-13 | The default 'Update my existing retirement account' decision silently applies confirmation-gated contribution fields the user left unticked. |
| GAP-RET-02 | P1 | WP-03, WP-05, WP-13 | A statement period total is written into a column consumers read as a rate, without a frequency. |
| GAP-RET-03 | P1 | WP-13 | Retirement evidence is not user-visible after apply. |
| GAP-RET-04 | P2 | WP-13 | Header evidence fields are persisted but never rendered, even during review: salary_sacrifice, government_contributions, rollovers_in, rollovers_out, withdrawals, pens... |
| GAP-RET-05 | P2 | WP-01, WP-13 | Extraction silently drops data. |
| GAP-RET-06 | P2 | WP-13 | There is no economic as-of date on the canonical balance. |
| GAP-RET-07 | P2 | WP-13 | A personal contribution or withdrawal matched to a bank transaction is only linked (fdh_retirement_statement_activities.linked_transaction_id), never reclassified. |
| GAP-RET-08 | P2 | WP-07, WP-13 | Imported retirement rows carry no provenance label. |
| GAP-RET-09 | P2 | WP-13 | Authenticated users can INSERT forged approved evidence. |
| GAP-RET-10 | P2 | WP-00 | There is no field-disposition registry or CI test for the retirement adapter. |
| GAP-RET-11 | P3 | WP-13 | MEMBER_MISMATCH (added by 0119:189-192) is not in GENERIC_CODES or RETIREMENT_APPLY_REFUSAL_CODES, so it collapses to WRITE_FAILED, and the apply route returns 400 ins... |
| GAP-RET-12 | P3 | — | PDF super statements (the most common real format) are not machine-readable. |
| UPL-01 | P2 | WP-01, WP-08, WP-09 | Payslip and bank PDF extraction has no wall-clock timeout, so residual R-14-8 (brief §129) is STILL OPEN on current main. |
| UPL-02 | P2 | WP-12 | The India II CAS upload (the live, flag-free PDF surface) skips the real GuardDuty scan without any warning to the user when migration 0196's columns are absent. |
| UPL-03 | P3 | WP-08 | The generic FDH upload page (/financial-data-hub) is reachable in production by direct URL. |
| INS-00 | P3 | WP-00 | ACTIVE USER FLOW: NO for Insurance and for all AIE-fronted adapters (generic, FDH-bank, II adapter, Insurance). |
| INS-01 | P2 | — | (Latent) waitingPeriodDays drops the unit: '4 weeks' becomes 4 days and '3 months' becomes 3 days in the canonical row. |
| INS-02 | P2 | — | (Latent) Renewal and premium notices create DUPLICATE insurance_policies rows, because the review UI never sends masterItemKey and registry.save always inserts when th... |
| INS-03 | P2 | — | (Latent) An imported policy carries no provenance label, and its evidence-only fields are not user-visible after Apply. |
| INS-04 | P3 | — | (Latent) country_code is never populated on imported insurance policies. |
| INS-05 | P3 | — | (Latent) The raw coverage-type label is lost when it normalises to 'other' (TPD, trauma), and unrecognised labelled lines that carry no money value are silently dropped. |
| INS-06 | P3 | — | (Latent) The insurance write is not atomic. |
| INS-07 | P3 | WP-00 | No field-disposition registry or CI orphan test covers the insurance adapter (brief §29). |
| UPL-04 | P3 | WP-08 | The header comment on the malware config contradicts the code. |
| DC-01 | P0 | WP-03 | Imported bank actuals only count if dated in the CURRENT calendar month (UTC). |
| DC-02 | P0 | WP-02, WP-03 | Planned + actual are added together by default. |
| DC-03 | P0 | WP-02, WP-03 | The Dashboard defines 'bank expense' differently from the certified FDH-7/FDH-8 oracle, so the same approved transactions give different totals. |
| DC-04 | P0 | WP-05 | The Twin/Benchmark computes its own DashboardSummary with no imported bank income/expenses, no superseded flag, no SMSF property-loan override, no business entities, n... |
| DC-05 | P1 | WP-03, WP-04 | hasIncome/hasExpenses count only manual non-superseded rows. |
| DC-06 | P1 | WP-02, WP-03 | Liability debt service is double-counted against imported loan actuals. |
| DC-07 | P1 | WP-11 | Credit-card purchases never become canonical events: no migration or lib path inserts into fdh_transactions from a liability apply. |
| DC-08 | P1 | WP-02, WP-06, WP-12 | Imported AU investment holdings are not in Net Worth after Apply. |
| DC-09 | P1 | WP-06 | Report staleness ignores imported data. |
| DC-10 | P1 | WP-06 | The premium-report appendices claim to 'list every recorded item used in this report's calculations', but income/expense appendices include superseded rows (excluded f... |
| DC-11 | P1 | WP-02, WP-03 | Imported actuals are excluded from essentials. |
| DC-12 | P1 | WP-02, WP-03 | Currency mixing inside computeDashboard. |
| DC-13 | P1 | WP-05 | Currency mixing in Twin metrics and forecast goal variance: raw AUD+INR sums. |
| DC-14 | P2 | WP-03, WP-04, WP-05 | Error->0 / null->0 coercions that make a failed read look like a real zero. |
| DC-15 | P2 | WP-04 | Non-atomic, repeated dashboard computation. |
| DC-16 | P2 | WP-02 | Bank statement closing balances and account balances never reach canonical assets (cash). |
| DC-17 | P2 | WP-07 | The Expenses tab does not show approved imported actuals (the brief requires 'Woolworths $200 Groceries' to be visible alongside planned). |
| DC-18 | P2 | WP-04, WP-05 | Unpaginated register reads outside Dashboard. |
| DC-19 | P3 | WP-03 | Direct fdh_* reads in downstream code. |
| X-01 | P1 | WP-09, WP-11, WP-13 | "Update existing" applies confirmation-gated fields the user left unticked (income 0120:113, liability 0096:840, retirement 0119:147). |
