# FDH-8 — Live DEV Certification

**STATUS: ATTAINED — 2026-08-25.** This supersedes the prior version of this document, which reported live DEV certification as structurally unreachable (no `.env.local` in that session's worktree). `.env.local` was copied from `D:/FHIP/.env.local` per the project's established per-worktree pattern, and the target project was independently confirmed as `vqycarelcoijzwlpkpcz.supabase.co` — the same DEV project referenced throughout every prior FDH/Investment-Intelligence certification document in this program (cross-checked against `docs/database-reconciliation/*.md`), never production (production is a separate, dedicated project per `DEPLOYMENT.md`'s own explicit instruction: "do not reuse any existing development/test Supabase project").

## What actually ran

`scripts/fdh8_live_dev_certification.ts`, run with `npx tsx scripts/fdh8_live_dev_certification.ts http://localhost:3232` against a real `next dev --webpack` server, talking to:
- the real running Next.js app for every FDH-8 read and every FDH-7 review/approval action (real HTTP requests, real session cookies from a real Supabase-issued JWT), and
- the real DEV Supabase project via REST with the service-role key for test-data SETUP and ground-truth verification/cleanup only (matching the established pattern of every other live-cert script in this codebase — `fdh6_live_dev_certification.ts`, `r8_live_dev_certification.mjs`, etc.).

**Final result: 44 PASS, 0 FAIL, 1 INFO (of 45).** Full log preserved in this session's evidence; the single INFO line is the environment-identity confirmation (`FDH8-ENV-00`), not a test outcome.

## Live Case 1 — Approved Expense

Groceries -$100 inserted, approved through the real `POST /api/financial-data-hub/bank-transactions/{id}/approve` endpoint. Live `GET /api/financial-data-hub/activity/overview` reported **Approved expense = $100.00** exactly. PASS.

## Live Case 2 — Approved + Pending [THE MOST SCRUTINISED TEST IN THIS PROGRAM]

Approved income $4,250 (via the real approve endpoint) + a genuinely pending $180 expense (never approved — `approval_status` left at its DB default `'pending'`) inserted for the same period. The real, live FDH-8 overview API returned:

```
Approved income:  $4,250.00 exactly
Pending expense:  $180.00, disclosed SEPARATELY, never merged
Forbidden $4,430: does not appear anywhere in the response (grep-verified on the raw JSON)
```

**Negative control (non-vacuous proof):** a raw query variant run only inside this script (service-role key, no `approval_status` filter — never altering production code or RLS) shows dropping the filter WOULD produce $180.00 unscoped expense contamination — the exact `$4,430` forbidden total the spec calls out. The correctly-scoped live API result ($0 approved expense for this period, since the only txn was pending) differs from this negative control, proving the live assertion is genuinely exercising the approval-status boundary, not passing by coincidence.

## Live Case 3 — Confirmed Transfer

CBA -$500 / savings +$500, linked as `internal_transfer`, confirmed via the real `POST /transaction-links/{id}/review` endpoint, both legs approved. Live per-account view (`GET /activity/accounts`):
- Transfer-out leg: Income=$0, Expense=$0 (transferTotal=$500, correctly bucketed separately)
- Transfer-in leg: Income=$0, Expense=$0 (same)

Neither leg inflates income or expense on its own account, confirming transfer-safety holds through the real API, not just the oracle in isolation.

## Live Case 4 — Duplicate [genuine defect found + fixed here]

A $6.50 "Coffee" pair inserted with `dedup_status='duplicate_candidate'` on both rows (the real precondition R8's own detection pipeline sets — confirmed by reading `bank-csv/dedup.ts`), a `fdh_duplicate_candidates` row created, resolved via the real `POST /duplicate-resolution` endpoint with `resolution: 'removed_b'`.

**First run of this test found a real, live financial-integrity bug**: `resolveDuplicateCandidate()` was setting the SAME `dedup_status` on BOTH sides of the pair for every non-`kept_both` resolution. Since `computeApprovedFinancialSummary` excludes every row whose `dedup_status` is `'user_confirmed_duplicate'` from every total, unconditionally, by design — this meant a resolved duplicate pair contributed **$0** to every total instead of the kept transaction's amount counted exactly once. Live-reproduced: the $6.50 pair resolved to `removed_b` produced $0.00 approved expense, not $6.50.

**Fixed** in `lib/financial-data-hub/services/bankTransactionActionsService.ts` (see `resolveDedupStatusPerSide()`) — each side of the pair now gets its OWN dedup_status: the kept side `'user_confirmed_distinct'` (counts normally), the removed side `'user_confirmed_duplicate'` (excluded, provenance preserved). New regression test: `tests/unit/fdh7DuplicateResolutionDedupStatus.test.ts` (5/5 PASS), including an explicit negative control asserting no resolution path can ever exclude both sides.

**Re-run after the fix**: live expense total for that day = **$6.50 exactly**, not $13.00 (double-count) and not $0.00 (the bug this fix closed). PASS.

## Live Case 5 — Refund

Expense $100 + a confirmed refund $20 (linked `refund_original`, confirmed via the real review endpoint, both approved). Live expense total = **$80.00 exactly** — the same FDH-7 oracle treatment FDH-8 reuses, no separate refund arithmetic in FDH-8 itself. PASS.

## Live Case 6 — Split [genuine gap found, disclosed not fixed]

Costco -$300 split into Groceries-equivalent $220 + Housing-equivalent $80 via the real `POST /split` endpoint (`finalize: true`).

**Found**: the split transaction's PARENT row never has its `economic_transaction_type` changed away from `'unknown'` by `splitTransaction()`, and `fdh7_transaction_has_blocking_issue()` (a SQL function shipped in migration 0076) blocks approval whenever `economic_transaction_type='unknown'` WITHOUT checking whether reconciled allocations already exist. **This means a transaction split from an initially-uncategorised parent can never be approved through the split action alone** — a real gap in FDH-7's DB-level approval gate.

**Not fixed here.** The fix is a `CREATE OR REPLACE FUNCTION` on `fdh7_transaction_has_blocking_issue`, which requires a migration — an explicit STOP condition under this closure's standing constraints ("if your closure work reveals a genuine schema requirement, treat that as a STOP condition, do not casually add one"). **Flagged for Product Owner attention and a future migration.**

To still certify the underlying FINANCIAL correctness (the part FDH-8 owns), the live script used the real, already-available workaround — a `POST /correction` call setting `economic_transaction_type='expense'` on the parent (exactly the same action FDH-8's new review page exposes) — after which the split transaction approved cleanly. Result: **Total expense = $300.00 exactly** (never $600, the forbidden double-count), **Groceries-equivalent = $220.00**, **Housing-equivalent = $80.00**. All PASS.

## Live Case 7 — Multi-Account

2 real accounts (from Case 3). Household totals (`GET /activity/accounts` → `household`) reconcile EXACTLY with the sum of every per-account row (`accounts[].activity[]`) — same fetched transaction set, no second independently-drifting query. PASS.

## Live Case 8 — CSV Path

A real CBA CSV fixture uploaded through `POST /bank-csv/upload`, detected, processed (5 canonical transactions created, reconciled), classified via the real FDH-6/R8 pipeline, at least one transaction approved through the real approve endpoint, FDH-8 overview loads without error afterward. PASS.

## Live Case 9 — PDF Path

A real synthetic CBA PDF statement built with the existing `buildBankPdfFixture` helper, uploaded through `POST /bank-pdf/upload`, processed, classified, approved, FDH-8 overview loads without error. Same downstream analytics surface as the CSV path (no format-specific FDH-8 branch — confirmed by both paths landing in the same overview response shape). PASS.

## Phase D — Live Tenant Isolation

Real Tenant A and Tenant B DEV sessions.

| Check | Result |
|---|---|
| Tenant B forges Tenant A's `account_id` in `/activity/overview` | 0 unauthorized aggregate contribution — PASS |
| Tenant B direct access to a Tenant A transaction id (`GET /bank-transactions/{id}`) | 404, RLS-enforced — PASS |
| Tenant B forges Tenant A's `account_id` in the Transaction Explorer | 0 rows — PASS |
| Tenant B forges Tenant A's `account_id` in `/activity/spending` | 0 categories — PASS |
| **Real RLS-enforced direct PostgREST read** (anon key + Tenant B's own JWT, no service-role bypass) of a Tenant A row | 0 rows returned — PASS |
| **Control**: Tenant B genuinely CAN see their own approved data | $42.00 expense correctly returned — PASS (proves isolation above is not "nothing works") |

The `RLS alone (no app-layer filter)` negative control is certified at the DB/PGlite layer (`scripts/fdh8_certification.mjs` SECTION 2, reproduced fresh, 4/4 PASS) rather than by disabling a real RLS policy on the shared live DEV project — per this closure's standing constraint ("never actually alter a live RLS policy on the shared DEV database"), since three other background tasks are running concurrently against this same DEV project.

## Cleanup

Every synthetic row this script created (test users, accounts, transactions, links, duplicate candidates, documents) was deleted, then **independently re-queried** (not trusted from the cleanup script's own success output): `FDH8-CLEANUP-01` (0 leftover transaction rows) and `FDH8-CLEANUP-02` (0 leftover test users) both PASS.

## What this does NOT cover

- Live keyboard-navigation/screen-reader testing of the authenticated FDH-8 pages via the Claude Browser tool was attempted but blocked by a browser-automation input-event issue unrelated to the app (the real login form's own accessible structure — labelled inputs, a `<form>`, a submit button, all with correct accessible names — was independently confirmed live; see `FDH8_ACCESSIBILITY_CERTIFICATION.md` for what was and was not verified this way).
- Production — not touched, not attempted, per standing constraints. See `FDH8_PRODUCTION_CERTIFICATION.md`.
