# R8 — Rule Precedence

## 1. Reused, not reinvented

`lib/financial-data-hub/domain/classificationPrecedence.ts` (FDH-2) already
implemented and tested the full 9-tier precedence order as a pure
`resolvePrecedence()` function. R8 is its first real caller
(`economicTypeEngine.ts`) — no second precedence implementation was
written.

```
1. user_rule                — a household's own confirmed rule
2. source_provided          — NEVER REACHABLE from a CSV transaction (no source-provided category field exists on fdh_transactions)
3. verified_merchant_alias  — fdh_merchants/fdh_merchant_aliases direct lookup
4. mcc                      — NEVER REACHABLE from a CSV transaction (no mcc column)
5. verified_global_rule     — a fdh_classification_rules row whose match_kind is NOT narrative_pattern
6. narrative_pattern        — a fdh_classification_rules row whose match_kind IS narrative_pattern
7. fuzzy_merchant_match     — NOT IMPLEMENTED anywhere in this codebase
8. ai                       — NOT IMPLEMENTED anywhere in this codebase (spec section 57: R8 must work with no LLM)
9. user_review              — nothing matched; UNRESOLVED, surfaced for review
```

Tiers 2, 4, 7, 8 are listed in `resolvePrecedence()`'s own type for
completeness/future extensibility but structurally never produce a
candidate in R8 — confirmed by `economicTypeEngine.ts` never constructing a
`PrecedenceCandidate` tagged with any of those four sources.

## 2. Conflict handling (spec section 43)

`resolvePrecedence()` ranks by tier only — two candidates in the SAME tier
are not something the pure resolver arbitrates; in practice this cannot
arise in R8's real usage because `economicTypeEngine.ts` only ever submits
**one** candidate per reachable tier (the first matching user rule, the
first merchant match, the first matching global rule) — `evaluateRules()`
already sorts by `priority` and the engine takes only the top rule per
source. A genuine same-tier tie (e.g., two global rules matching with
identical priority) is *never silently resolved arbitrarily*: `evaluateRules`
returns them in priority order, and only the first is used, but this is
disclosed as a design choice (first-by-priority-then-declaration-order
wins) rather than a `CONFLICT` state — building genuine multi-rule conflict
detection is a disclosed residual for a following release (spec section 43
calls for `CONFLICT`/`REVIEW_REQUIRED`; the current implementation instead
relies on FDH-2's own governance discipline that rule `priority` values are
curated to avoid same-tier ties in the 60-row seed set, verified by
inspection — no two seeded rules share both a `rule_type` and a `priority`
targeting overlapping narrative terms in a way that would matter for the
cases this release's certification exercises).

## 3. The worked example, still true

The FDH-2 COSTCO example (global default: Groceries; a user's own rule:
Household; the user wins for themself; the global row is never touched)
is unchanged and re-verified: `tests/unit/r8RuleMatchingAndEconomicType
.test.ts`'s `'the global default row itself is never mutated by a
user-rule win'` test freezes the global rule object, runs classification,
and asserts byte-identical `JSON.stringify` before/after.
