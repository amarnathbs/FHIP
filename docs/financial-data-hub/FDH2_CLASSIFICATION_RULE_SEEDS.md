# FDH2_CLASSIFICATION_RULE_SEEDS

## 1. Schema — reuses FDH-1's `fdh_classification_rules` unchanged in shape

`rule_key`, `rule_type`, `country_applicability`, `match_definition`
(jsonb), `action_definition` (jsonb), `priority`, `status`, `active`,
`version` are all FDH-1 columns. FDH-2 widens `rule_type`'s check
constraint (additive: adds `narrative_pattern`, `payment_rail_narrative` to
FDH-1's original six) and adds two new `match_kind`/`action_kind`
discriminated-union members to the Zod validators in
`lib/financial-data-hub/validation/classification.ts` — the database's own
shape constraint (`match_definition ? 'match_kind'`,
`action_definition ? 'action_kind'`) already accommodated this without a
migration change.

## 2. The two new match/action kinds, and why they exist

**`narrative_pattern`** (`required_terms_normalised[]`,
`excluded_terms_normalised[]?`, `source_context?`, `country_code?`) — the
FDH-1 `description_contains` member only supported one bare needle and
could not express "PAY excluded unless PAYROLL" style rules. This is what
lets `income_salary_generic` require `SALARY` while excluding `SALARY
SACRIFICE`/`SALARY PACKAGING`, and what lets every fee rule require `...
FEE` while excluding `FEE WAIVED`/`FEE REVERSED`/`FEE REFUND`. Bare terms
like `PAY`/`PAYMENT`/`TRANSFER`/`CREDIT` are used ALONE in exactly zero
rules.

**`payment_rail_narrative`** (`rail_key`, `narrative_terms_normalised[]`) —
recognises a payment mechanism (UPI, BPAY, EFTPOS, NEFT, ...) paired
STRUCTURALLY with the `annotate_payment_rail` action, which carries only
`rail_key` — never an economic type, category or subcategory. A rail
annotation can never, by construction, become a classification.

**`flag_candidate`** (`candidate_type`, one of `transfer_candidate` /
`liability_settlement_candidate` / `investment_funding_candidate` /
`possible_duplicate_review`) — the specification's TRANSFER_CANDIDATE /
LIABILITY_SETTLEMENT_CANDIDATE / INVESTMENT_FUNDING_CANDIDATE suggestions,
made structurally non-authoritative: this action shape has NO
`economic_transaction_type`/`category_id`/`subcategory_id` field at all
(proved by black-box Zod tests in `tests/unit/fdh2Validation.test.ts` —
even a caller that tries to smuggle those fields in gets them silently
stripped by the schema).

## 3. Seed inventory (60 rules)

| Group | Count | rule_type |
| --- | --- | --- |
| Income / salary | 8 | `narrative_pattern` |
| Government payment (AU + India) | 8 | `narrative_pattern` |
| Transfer candidates | 4 | `narrative_pattern` (action: `flag_candidate`) |
| Credit-card payment candidates | 4 | `narrative_pattern` (action: `flag_candidate`) |
| Investment transfer candidates | 3 | `narrative_pattern` (action: `flag_candidate`) |
| Bank fee | 8 | `narrative_pattern` |
| Interest (direction-aware) | 4 | `narrative_pattern` |
| Cash withdrawal | 3 | `narrative_pattern` |
| Refund / reversal | 4 | `narrative_pattern` |
| Payment-rail annotation (AU: 8, India: 6) | 14 | `payment_rail_narrative` |
| **Total** | **60** | |

Full authored list: `data/financial-data-hub/classificationRules.mjs`.

## 4. Precedence — documented, not implemented as a runtime engine

The full order (highest first): **user rule > explicit reliable source
classification > verified exact merchant alias > MCC > verified global rule
> source/narrative pattern > fuzzy merchant match (not implemented) > AI
(not implemented) > user review**. A user's confirmed personal rule ALWAYS
outranks the global default FOR THAT USER — the specification's own worked
example (global COSTCO -> Groceries default; a user's own rule sets COSTCO
-> Household for themself; the user wins; the global row is never touched)
is implemented as a pure, tested resolver function,
`lib/financial-data-hub/domain/classificationPrecedence.ts`
(`resolvePrecedence`, `applyUserOverrideExample`), NOT as the full
transaction-classification engine (FDH-6). 18 unit tests in
`tests/unit/fdh2Domain.test.ts` exercise every adjacent pair in the order,
an empty-candidate-list case, an unrecognised-source error case, and the
worked COSTCO example itself — including a live-database proof
(`scripts/fdh2_rls_certification.mjs`, "PRECEDENCE PROOF" section) that the
global `fdh_merchants` row for `costco_au` is byte-identical before and
after two different tenants each write a personal COSTCO rule.

## 5. Cash withdrawal, transfer, refund — deliberately incomplete by design

Cash-withdrawal rules classify the movement as `cash_withdrawal` — never as
household consumption (what the cash was later spent on is unknown).
Transfer/credit-card-payment/investment-transfer rules never auto-classify;
they flag a CANDIDATE only, because confirming a transfer requires matching
the counterpart movement by amount/date/account (FDH-6). Refund/reversal
rules classify the movement as `refund` but make no attempt to LINK it back
to the original transaction (also FDH-6).

## 6. Governance

Every seeded rule is `status = 'approved'`, `active = true`, `version = 1`
— these are FHIP's own reviewed pattern seeds, not user proposals awaiting
review. `fdh_classification_rules` carries no write policy for
`anon`/`authenticated` (FDH-1 RLS, unchanged) — a rule can only be added
via a service-role-authenticated migration/seed path, proven live by
`scripts/fdh2_rls_certification.mjs`'s write-denial section.
