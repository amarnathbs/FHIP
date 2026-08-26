# II-R11 Independent Live Reconciliation — 12/12

Script: `scripts/r11_independent_live_reconciliation.mjs`. Defines a frozen, independently-authored expectation (written from the R11 spec/architecture docs' own accounting and permission invariants, not from reading R11's production code) for 6 multi-source and 6 professional-access scenarios, then cross-checks those expectations against the actual live-DEV results captured the same run by `scripts/r11_final_live_dev_tests.ts` and `scripts/r11_professional_live_dev_tests.mjs`.

## Multi-source (6/6)

| Scenario | Independent reasoning | Expected | Live result |
|---|---|---|---|
| Full overlap (CAMS then KFintech) | Two sources describing the same real-world purchase must resolve to one canonical row | PASS (no duplicate) | PASS |
| Reverse import order | Economic reality does not depend on upload order | PASS (identical canonical result) | PASS |
| Partial overlap (3 funds, 1 shared) | Union of partially-overlapping evidence = 3 distinct instruments | PASS (3 distinct, 1 dedup) | PASS |
| Genuine conflict (same identity, different amount) | Disagreeing sources must never be silently overwritten | PASS (review_required + open case) | PASS |
| Different as-of dates | Later snapshot with more units is legitimate growth, not conflict | PASS (both retained, 0 blocking cases) | PASS |
| Incomplete tax basis | No transaction history = no factual basis for a cost/tax lot | PASS (0 tax lots, explicit incomplete marker) | PASS |

## Professional access (6/6)

| Scenario | Independent reasoning | Expected | Live result |
|---|---|---|---|
| Authorised access | Explicit accepted grant allows that resource class | ALLOW | PASS (200) |
| Ungranted scope | One granted scope must not imply another | DENY | PASS (403) |
| Report scope allow/deny | Report access gated on its own scope, same underlying R10 report | ALLOW after grant, same report_id | PASS |
| Raw document denial | No raw-document scope exists — every raw path must deny | DENY on all paths | PASS (400/400/404) |
| Same-token post-revocation | Authorization checked against current state, not cached | DENY, no re-login | PASS (403) |
| Cross-client denial | Authorised-for-A must never generalise to B | DENY on every B resource | PASS (403) |

**Total: 12/12 independently reconciled, 0 mismatches.**
