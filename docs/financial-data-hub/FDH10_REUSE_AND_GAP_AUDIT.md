# FDH-10 — Reuse & Gap Audit

Repository state at dispatch: `origin/main` at `2d6d1e9`. FDH-3/7/8/9 all present and certified. Highest migration on main: `0095`. `0093` reserved by unmerged `feature/education-goal-linkage`. Migration guard + cross-branch/cross-worktree collision guard both re-run fresh (`git fetch --all`, `git ls-tree` over every local branch/worktree/`doclife`/`origin` remote) — genuine next number confirmed as `0096`.

## Headline finding

**FDH-1 (migrations 0045-0048) already anticipated FDH-10 in its original schema design**, before FDH-10 was ever scoped:

| Capability | Already exists | Where |
|---|---|---|
| Credit-card/loan account types | `fdh_financial_accounts.account_type` has `credit_card`, `home_loan`, `personal_loan`, `vehicle_loan` | 0046 |
| Credit-card/loan document types | `fdh_statement_uploads.document_type` has `credit_card_statement`, `loan_statement` | 0046 |
| Economic vocabulary for card/loan activity | `fdh_transactions.economic_transaction_type` has `debt_principal`, `debt_interest`, `fee`, `refund`, `cash_withdrawal` | 0047 |
| Repayment-decomposition mechanism | `fdh_transaction_allocations` (the split-transaction table) | 0047 |
| Bank-match relationship vocabulary | `fdh_transaction_links.link_type` has `credit_card_settlement`, `loan_payment` | 0047 |
| Generic import bridge, liability-ready | `fhip_import_proposals`/`fhip_import_applications.target_domain` already includes `'liability'`; `IMPORT_SOURCE_KINDS` already includes `'loan_statement'` | 0091 (FDH-9) |

This materially changed the shape of FDH-10: most of the "reuse, don't duplicate" requirement is satisfied by **using existing tables/columns**, not by building parallel infrastructure that merely resembles them.

## Classification of every capability named in spec section 10

| Capability | Classification | Notes |
|---|---|---|
| FDH-3 document lifecycle | REUSE AS-IS | `fdh_statement_uploads` already has the card/loan document types; no new bucket, no new upload path |
| R7/FDH-4 bank CSV, FDH-5 bank PDF | REUSE (infrastructure only) | `parseCsvSafe`/`decodeCsvBytes`/`detectDelimiter`/`parseAmountField`/date-format inference reused verbatim by `lib/financial-data-hub/liability/csvExtraction.ts`. No new CSV/PDF parser primitives written |
| R8 categorisation, FDH-6 classification | REUSE AS-IS | Card purchases become ordinary `fdh_transactions` rows and pass through the SAME classification pipeline as bank-derived transactions — no second categorisation system built |
| FDH-7 review/approval | REUSE AS-IS | No second review-state machine; `review_status` columns on the new tables reuse the same 4-value vocabulary (`not_required`/`pending`/`in_review`/`resolved`) FDH-1 established |
| FDH-8 Expense Tracker | REUSE AS-IS | `financialActivityAnalytics.ts` needs zero changes — it already aggregates by `economic_transaction_type` + allocations, which is exactly what card/loan activity classification produces |
| FDH-9 generic import bridge | EXTEND | `target_domain='liability'` branch added to the same-tenant trigger functions; a new typed `liabilityAdapter.ts`; a new typed `fdh10_apply_liability_proposal()` RPC. No second proposal framework |
| Existing liabilities schema | EXTEND | Additive columns only (masked_identifier, minimum_payment, available_credit, due_date, arrears_status, provenance) — every existing column/row/policy untouched |
| Property↔Liability linking (0078) | OUT OF SCOPE (preserved, not touched) | No FDH-10 code references `property_liability_links` at all — statement import updates the existing linked Liability by facility identity; the property relationship is structurally unreachable from any new code path |
| debt_type / facility taxonomy | EXTEND | 4 new values added additively (`investment_property_loan`, `line_of_credit`, `overdraft`, `other_term_loan`) to the app-level zod enum; DB has no CHECK constraint on this column today (confirmed by reading migration 0003) so no DB widening was needed there |
| Money/date utilities | REUSE AS-IS | `lib/financial-data-hub/domain/money.ts` (`sumMoney`/`moneyEquals`/`toMinorUnits`) used by every FDH-10 reconciliation/decomposition function; zero new arithmetic primitives |
| Statement/activity model (spec 19-20) | NEW FDH-10 CAPABILITY | `fdh_liability_statements` + `fdh_liability_statement_activities` — genuinely new, because nothing in the existing schema captures card/loan-specific evidence (opening/closing balance, credit limit, minimum payment, principal/interest/fee decomposition) at the statement level |
| Repayment decomposition engine | NEW FDH-10 CAPABILITY (logic) / REUSE (storage) | The decision logic (`repaymentDecomposition.ts`) is new; the STORAGE mechanism it targets (`fdh_transaction_allocations`) is 100% reused from FDH-1 |
| Bank/facility matching engine | NEW FDH-10 CAPABILITY | `bankMatching.ts`/`facilityMatching.ts` — no equivalent existed; FDH-1 explicitly shipped `fdh_transaction_links` with "NO MATCHING ALGORITHM IMPLEMENTED" |
| AU/India localisation | REUSE AS-IS | `country_code`/`currency_code` columns and the existing `countries`/`currencies` reference tables; no new localisation infrastructure |
| Audit infrastructure | EXTEND | `fdh_document_audit_events.event_type` widened additively with 7 new FDH-10 event types, same technique as every prior phase |

## Isolation discipline

`tests/unit/fdh1Isolation.test.ts` enforces that nothing outside `lib/financial-data-hub/` imports it except an explicit, named allow-list. `lib/import-bridge/adapters/liabilityAdapter.ts` follows `incomeAdapter.ts`'s established precedent exactly: it does **not** import the Hub's own `facilityMatching.ts`, instead carrying a small, independently-tested duplicate of the same matching rule. Verified: the isolation test's "imported by nothing outside itself" check passes with zero new approved-consumer entries required.

## Zero-duplicate-engine confirmation

- One document lifecycle (FDH-3).
- One bank-transaction ledger (`fdh_transactions`), one split mechanism (`fdh_transaction_allocations`), one link/match vocabulary (`fdh_transaction_links`) — card/loan economic activity is written into these, not a parallel ledger.
- One classification engine (R8/FDH-6) — reused unmodified.
- One review/approval state machine (FDH-7) — reused unmodified.
- One import-proposal framework (FDH-9's bridge) — extended with one new domain adapter and one new typed apply RPC, not a second framework.
- One canonical Liability truth (`liabilities`) — FDH-10 updates it after Apply; no second net-worth calculation.

## Disclosed gaps carried into this pass (see `FDH10_COMPLETION_REPORT.md` for the full, honest list)

- No per-institution PDF/CSV adapters (AU/India bank-specific layouts) were built for credit-card/loan statements — only one generic, explicitly-column-mapped CSV extractor (`csvExtraction.ts`). Per-institution adapters are the single largest scope reduction in this pass.
- No Liabilities-tab UI/API-route surface was built (FDH10-K) — the engine, adapter, and atomic-apply RPC are complete and independently certified, but nothing in `app/` wires them to a user-facing upload/review/apply flow yet.
- Scale certification (100→10,000 rows) and the 150+ scenario volume target were not executed at full count; the two headline financial controls and the security/bridge matrix were prioritised and certified in full instead, per this dispatch's own priority ordering.
