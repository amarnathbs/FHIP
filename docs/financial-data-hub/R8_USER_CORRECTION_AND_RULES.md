# R8 — User Corrections & Rules

## 1. Corrections — the existing R7 mechanism, now genuinely load-bearing

`fdh_transaction_corrections` + `correctTransaction()`
(`bankTransactionActionsService.ts`, unmodified by R8) already shipped in
R7. Its `field_name` closed vocabulary already included `economic_
transaction_type`/`category_id`/`subcategory_id`/`merchant_id` before any
classifier existed to give the "system value" side meaning. R8 does not
touch this service — it hardens the DATABASE side (migration 0067's
"evidenced write" trigger, see `R8_SECURITY_VERIFICATION.md`) so the
already-shipped feature keeps working exactly as before while a bare
forgery attempt (an UPDATE with no corresponding correction row) is now
rejected.

**Preserved fields (spec section 46)**: `fdh_transaction_corrections`
retains `previous_value` (system result before), `corrected_value` (the
user's decision), `corrected_at` (timestamp), `user_id` (actor) — append
only, never edited or deleted. The "effective result" is simply the
current `fdh_transactions` row (there is no separate materialised view);
`user_override = true` marks it permanently exempt from reprocessing.
`fdh_classification_history` separately records the SYSTEM side of any
change (previous/new value, `classification_method`, `confidence`,
`changed_by_type`, `global_rule_id`/`user_rule_id`) — together the two
tables give a complete system-result / user-correction / effective-result
/ timestamp / actor / rule-source trail without R8 inventing a new schema.

## 2. Reusable personal rules — deliberate action only (spec section 47)

`POST /api/financial-data-hub/user-rules` (`classificationReviewService
.ts#createPersonalClassificationRule`) is a standalone, explicit action —
never triggered automatically from a correction. Writes exclusively to
`fdh_user_classification_rules`; the database structurally prevents any
promotion to a global rule (no INSERT/UPDATE policy exists on
`fdh_merchants`/`fdh_classification_rules` for the authenticated role at
all, confirmed unchanged from FDH-2).

## 3. Scope (spec section 48)

`fdh_user_classification_rules.rule_type` supports transaction-adjacent
scopes already defined by FDH-1/FDH-2:

| `rule_type` | Effective scope |
|---|---|
| `merchant_exact`/`merchant_alias` | Every future transaction matching that merchant/alias, for this user |
| `description_contains`/`narrative_pattern` | Every future transaction whose description matches, for this user |
| `institution_narrative` | Scoped to one institution's narratives, for this user |
| `account_scoped_default` | Scoped to one financial account, for this user |

Every rule carries `user_id` (RLS-enforced) — never crosses tenants; a
`household_id` column exists (nullable) for a future household-sharing
release but nothing in R8 wires cross-user visibility through it (each
rule remains scoped by `user_id`, not `household_id`, at the RLS layer).

## 4. Review decisions — the other legitimate user write path

Transfer/settlement/refund link review (`POST /transaction-links/{id}
/review`) and recurring-series review (`POST /recurring-transactions/{id}
/review`) are the two other bounded, explicit user-decision paths R8 adds
— narrow enough that migration 0067's own triggers independently enforce
the same transitions the application layer offers (see
`R8_SECURITY_VERIFICATION.md` section 4).
