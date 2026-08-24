# FDH-6 — Classification Precedence

## The order (unchanged from FDH-2/R8)

`domain/classificationPrecedence.ts`'s `PRECEDENCE_ORDER` (highest first):

1. `user_rule`
2. `source_provided` (not implemented — no source ever supplies a category)
3. `verified_merchant_alias`
4. `mcc` (not implemented — no CSV/PDF transaction carries an MCC)
5. `verified_global_rule`
6. `narrative_pattern`
7. `fuzzy_merchant_match` (not implemented)
8. `ai` (not implemented, not authorised)
9. `user_review` (nothing resolved — UNRESOLVED)

FDH-6 does not introduce a second precedence order. `economicTypeEngine.ts` still calls the same `resolvePrecedence()`.

## What FDH-6 added: within-tier conflict detection (spec section 57)

Before FDH-6, `economicTypeEngine.ts` took "the highest-priority match" at the user-rule and global-rule tiers by breaking out of a priority-sorted loop after the first classify-kind match. Two ACTIVE rules genuinely tied on priority with DIFFERENT outcomes were silently resolved by array order — not detected, not surfaced, and not even guaranteed deterministic (array order depends on the order the DB happened to return rows in).

`pickTopTierOrConflict()` groups the top-priority band within a tier and checks whether every rule in it agrees:

- **All agree** (identical category/subcategory/economic-type/merchant) → redundant, not contradictory. The first is used — deterministic, since "agree" means any of them produces the same result.
- **Disagree** → `RULE_CONFLICT`. A user-tier conflict short-circuits the WHOLE classification to `unknown`/`rule_conflict`, regardless of what a lower tier might otherwise resolve — the user's own contradictory instruction is the highest-precedence signal that exists and must not be silently bypassed. A global-tier conflict only matters (and only short-circuits) when no higher tier (user rule / verified merchant) already resolved the transaction — otherwise it is moot, exactly as normal precedence ranking would treat it.

Proven in `tests/unit/fdh6ThresholdsAndRuleConflict.test.ts`, including a negative-control test that classifies the SAME two conflicting rules in both array orders and asserts both produce `RULE_CONFLICT` — proving the result is order-independent, the exact defect this closes.

## Merchant matching, MCC, fuzzy matching — all unchanged

FDH-6 does not touch `merchantMatching.ts`. Verified-alias/canonical-name-only matching remains R8's exact, disclosed boundary. MCC and fuzzy matching remain structurally unreachable, by design (spec sections 12, 59, 62) — not a gap, a deliberate, disclosed boundary given no ingestion source in this repository carries MCC data.
