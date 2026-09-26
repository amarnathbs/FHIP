# APPROVED_UPLOAD_TO_CANONICAL_DATA_CONTRACT

Scope: every upload a user can reach today. That covers bank statements (CSV, native PDF and the AI-fallback draft), payslips, credit card and loan statements, AU broker statements, India CAS through Investment Intelligence, and retirement / super statements. Insurance and the AIE-fronted intakes have no active user flow; they are recorded as `not_active` and are not certified by this contract.

This contract is enforced in code. The field-disposition registry is `lib/canonical-data/disposition/*`, its gate is `tests/unit/uploadFieldDispositionRegistry.test.ts` (`npm run check:dispositions`), and the canonical read models are in `lib/read-models`. The per-field detail is in UPLOAD_FIELD_DISPOSITION_REGISTRY.md (generated). Every known gap is listed in APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md, section 10.

## 1. The governing rule

After a user uploads a document, reviews or corrects it, and explicitly **Applies / Approves** it, each approved financial fact ends in **exactly one** of these five dispositions:

| | Disposition | Examples | Must |
|---|---|---|---|
| **A** | Canonical financial **state** | `income_sources`, `liabilities`, `assets`, `retirement_accounts`, `investments`, `ii_*` holdings | Be written only by an explicit Apply, carry a provenance label, and be visible on its Input Data tab. |
| **B** | Canonical financial **event** | `fdh_transactions` + `fdh_transaction_allocations` + `fdh_transaction_links` (the approved transaction layer); `ii_transactions` | Count exactly once through the canonical read models. |
| **C** | Supporting **evidence** / provenance | payslip YTD, statement totals, super contributions and positions | Be **user-visible**, for example in statement details or contribution history. Never summed into a financial figure. |
| **D** | Derived / technical **metadata** | parser version, fingerprints, match status | Stay out of every financial figure. |
| **E** | Explicitly **unsupported** / rejected | broker cash (D-11), unreadable rows, PDF super statements | Come with a visible explanation. |

Nothing is dropped silently. The gate fails when a field an adapter extracts has no disposition (an **orphan**), and when a disposition names a field that no longer exists (**stale**). A deliberately injected orphan field is proven to fail it; see `uploadFieldDispositionRegistryAntiVacuity.test.ts`.

## 2. One fact, one economic effect

* **No copy tables.** Imported data is **never** copied into a manual-entry register to make it visible. `expense_items` stays the manual plan; approved `fdh_transactions` are the actuals; the read models present both side by side (CANONICAL_EXPENSE_DATA_CONTRACT.md).
* **Corroboration, not duplication.** Several documents can describe the same money: a payslip and its bank salary credit; a card statement's PAYMENT and the bank debit; a broker BUY / SELL / DIVIDEND and the bank leg; a super personal contribution and the bank debit. In every case there is **one** event. The bank leg is the household cash event, and the other document corroborates it. The read models check the match themselves (approved evidence, one-to-one, same direction, currency and amount) before they treat a leg as corroborated. The only sanctioned way to change a corroborated leg's type in the database is `fdh_internal_reclassify_corroborated_leg` (migration 0207). It skips rows the user has settled (`user_override`), writes correction evidence and is audited.
* **Oracles (brief):**
  * Card purchases of $200 and $20, repaid with $220: household expense **$220**.
  * A $2,000 loan payment (principal $1,550, interest $430, fee $20): cost of debt **$450**, debt service and cash outflow **$2,000**.
  * Payslip net $5,000 and a bank credit of $5,000: income **$5,000**.
  * Bank to broker $10,000 and a BUY: expense **0**.
  * A SELL of $15,000: ordinary income **0**.
  * A dividend of $400 at the broker and $400 at the bank: **$400**.
  * A rollover from fund A to fund B: income, expense and Net Worth all **0**.

## 3. Before and after Apply

* **Before Apply, the effect is 0.** Every read model counts only `approval_status = 'approved'` rows and Applied register rows. A pending line is counted as pending, never as money.
* **After Apply, the change shows at once.** The read models compute from rows on every request; there is no summary table to go stale (X-03: `fdh_approved_financial_summaries` is metadata only and is never read downstream).
* **Error is not 0, and null is not 0.** A failed read is `unavailable`. A missing value (unknown net pay, unknown contribution frequency) is `null`.
* **Currency is preserved.** Every line keeps its own amount and currency and is converted once. An unsupported currency is surfaced, never added in as if it were the reporting currency.
* **Self is not spouse (D-10).** Owner attribution is captured at upload: `fdh_financial_accounts.owner_role` and `fdh_payroll_events.income_owner` (0207). SMSF-owned data is the fund's, not the household's. Joint counts 100% to the household.

## 4. The Apply atomicity contract

Each Apply is a single SECURITY DEFINER RPC. It either succeeds completely or leaves nothing behind.

1. It locks the proposal and the source evidence, re-checks the proposal status (`ready`), the source approval and the target's `updated_at`, and refuses a stale proposal (409).
2. It writes the canonical state (A), with provenance (`source_type`, `last_import_application_id`, `last_imported_at`), and writes **only the fields the user ticked**. A confirmation-gated field is never applied unticked (X-01, fixed per domain in 0209, 0210 and 0211).
3. For FDH-10 (WP-11) it writes the ledger events (B) in the same transaction: the facility-account `fdh_transactions` rows, their allocations and the confirmed settlement links. It does this under the `fhip.import_bridge_internal_write` GUC, which `r7_block_authenticated_insert` now honours (0207). It stamps `fdh_liability_statement_activities.ledger_transaction_id` and records the effects in `fhip_import_applications.ledger_effects` (0207).
4. It records the application row and the proposal's `applied` status, and writes the audit event (`liability_ledger_applied`, `income_proposal_applied`, …) **inside** the transaction.
5. Repeating an Apply returns `ALREADY_APPLIED` and creates nothing new. Concurrent Applies are serialised by the lock and unique indexes (one application per payroll event, one ledger row per activity, one live proposal).

After a bank statement is approved, the post-bank-approval matcher seam (`lib/import-bridge/postBankApprovalMatchers.ts`, 0207) re-matches the evidence from other documents against the newly approved lines. A matcher that fails is audited (`post_approval_matcher_failed`) and never changes the approval.

## 5. Per-domain destinations

| Domain | A: state | B: events | C: evidence (visible at) | E: unsupported | Owner |
|---|---|---|---|---|---|
| Bank statement | closing balance: a cash-asset **proposal** the user Applies (D-04). Until then it is shown as "Bank balance per statement — not in Net Worth". | every approved line → `fdh_transactions` (+ splits and links), bucketed by `spendingRules` | posting / value date, reference, running balance, rejected rows, overlap notes (statement details) | AI-fallback truncation beyond 80 rows (blocking review) | WP-08 |
| Payslip | recurring gross, net and frequency → `income_sources` (owner self / spouse) | variable pay → one-off actual income, deduped against the matched bank credit (D-06) | tax, deductions, super, NPS, YTD, components (payslip details); employer super is never income | reimbursements (not income, visible) | WP-09 |
| Credit card / loan | balance, limit, minimum payment (ticked), rate, due date → `liabilities` | every activity → a facility ledger row; a PAYMENT → a transfer plus a confirmed settlement link; a loan payment → principal / interest / fee allocations | statement totals (must equal the ledger), opening balances, GST, warnings (statement history) | available credit, rate type, maturity, arrears (not on the statement, explained) | WP-10, WP-11 |
| AU broker | holdings → `ii_holding_snapshots` → published into `investments` after an explicit "Add to Net Worth" (D-05); shown as "Imported, not yet in Net Worth" until then | trades → `ii_transactions`; bank legs corroborated | settlement date, franking, withholding, import history | broker cash (D-11), corporate actions / unknown (reason shown) | WP-12 |
| India CAS | ii_* → published `investments` ("Imported via Investment Intelligence") | `ii_transactions` | holder, PAN (masked), statement period | — | closed |
| Retirement / super | closing balance, identity → `retirement_accounts`; contributions only when ticked, annualised (D-12) | — (a summary-balance register, not a ledger) | contributions, rollovers, earnings, fees, insurance, tax, positions (contribution history / "holdings in super", never Net Worth) | PDF statements (explained) | WP-13 |
| Insurance / AIE intakes | — | — | — | ACTIVE USER FLOW: NO (`not_active`; the inactive-flow guard fails if a UI starts calling them) | — |

## 6. Change control

* A new adapter field, evidence column or activity-type value **must** be added to the registry in the same change, or the gate fails (R1).
* A closed gap **must** lower its file's `OPEN_GAP_CEILING` (R6; the ceiling equals the current count).
* A new shared CHECK value, such as an error code or audit event type, is added **only** by migration 0207. Every other programme migration reuses it, so the drop-and-recreate revocation trap cannot recur. 0207 also refuses to run if the live constraint holds a value it does not list.
* `STRICT_CERTIFICATION` (R7) is turned on by WP-14. After that, any open P0 or P1 gap in an active adapter fails the gate.
