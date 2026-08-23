# R8 — Merchant Normalisation

## 1. Never overwrites raw evidence (spec section 38)

`merchant_raw` and `description_raw` are never written by any R8 code path
— confirmed by grep: neither string appears on the left-hand side of an
assignment anywhere in `lib/financial-data-hub/classification/*` or
`transactionClassificationService.ts`. Merchant identity is always DERIVED
metadata (`merchant_id`, a foreign key), never a mutation of the source
text.

## 2. Matching method (`merchantMatching.ts`)

1. Normalise (`toMatchText`): upper-case, collapse whitespace. Applied only
   at match time — never persisted.
2. Search verified aliases (`fdh_merchant_aliases.verified = true`) for a
   substring match against `description_clean` + `merchant_raw` combined.
3. Fall back to the merchant's own `canonical_name` as a substring match.
4. Both paths additionally require `verification_status = 'approved'` and
   `active = true` — an unverified alias or a merchant still in
   `admin_review`/`proposed` never matches (spec section 39: "global
   merchant aliases must be trusted/admin maintained").
5. On multiple matches, the LONGEST matched text wins — "WOOLWORTHS METRO"
   beats "WOOLWORTHS" — so a more specific alias is never shadowed by a
   shorter, more general one.

## 3. Fuzzy matching — explicitly not implemented

Tier 7 of the precedence order (`fuzzy_merchant_match`) is a documented,
disclosed gap across FDH-2, R7 and R8 — no fuzzy/similarity algorithm
exists anywhere in this codebase. `matchMerchant()` performs exact
(verified) substring containment only. This is a deliberate, disclosed
trade-off in favour of never mis-attributing a transaction to the wrong
merchant over maximising match rate.

## 4. Governance (spec section 39-40) — unchanged from FDH-2

- Global merchant/alias rows: service-role-write-only (no INSERT/UPDATE
  policy for `anon`/`authenticated`), country/context-aware
  (`country_code` on both `fdh_merchants` and `fdh_merchant_aliases`),
  provenance-backed (`source_key`, `verification_status`).
- User-specific mappings: `fdh_user_classification_rules` with
  `rule_type IN ('merchant_exact', 'merchant_alias')` — own-rows RLS,
  never propagates to the global tables (enforced at the database: no
  authenticated INSERT/UPDATE policy exists on `fdh_merchants`/
  `fdh_classification_rules` at all, so even a hypothetical application
  bug attempting to "promote" a user's alias globally would be rejected by
  Postgres, not merely by application logic).

## 5. Subscription/recurring metadata — likelihood only

`fdh_merchants.recurring_possible`/`typical_frequency`/`fixed_amount_
expected`/`variable_amount_possible` (FDH-2, widened into the TS
`FdhMerchant` type by this release since no prior consumer needed them) are
read as ONE input signal only — no R8 code path asserts a specific
transaction IS recurring purely because its merchant carries `recurring_
possible = true`. Recurring-series membership is determined solely by
`recurringDetection.ts`'s own gap-consistency analysis (see
`R8_RECURRING_DETECTION_METHODOLOGY.md`).
