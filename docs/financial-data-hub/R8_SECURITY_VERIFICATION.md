# R8 — Security Verification

## 1. Method

No DDL-execution credential exists in this environment (disclosed
throughout this release; see `R8_ASSUMPTION_RECONCILIATION.md` and the
final acceptance report), so migration `0067` cannot be applied to real DEV
and live-security certification against it cannot be performed in this
session. `scripts/r8_security_certification.mjs` is the mechanism used
instead — a PGlite full-migration rebuild (67/67 migrations, real Postgres
semantics, not a mock), real two-tenant data, `set_config('request.jwt
.claims', ...)` + `set role` to exercise `authenticated` and `service_role`
for real, following the exact pattern `scripts/db-rebuild-check/rls.mjs`
and `scripts/fdh2_rls_certification.mjs` established and multiple prior
FDH phases used for the same reason.

**Result: 30/30 passed**, including a genuine RED→GREEN negative control
and genuine cross-tenant checks. Full transcript in the completion report;
summary below.

## 2. Authoritative-write inventory (spec section 59)

| Table | Column(s) | Who may SELECT | Who may INSERT | Who may UPDATE | Who may DELETE |
|---|---|---|---|---|---|
| `fdh_transactions` | `economic_transaction_type`, `category_id`, `subcategory_id`, `merchant_id` | owner (RLS) | service-role only (0064) | owner, **evidenced only** (0067: requires a matching, <5-min-old `fdh_transaction_corrections` row) or service-role | owner (cascade via account/statement, unchanged) |
| `fdh_transactions` | `classification_confidence`, `classification_method`, `recurring_flag`, `subscription_flag`, `transfer_flag`, `recurring_transaction_id` | owner (RLS) | service-role only | **service-role only** (0067: blocked outright for authenticated — no correction vocabulary covers these) | — |
| `fdh_transactions` | `review_status` | owner (RLS) | service-role only | owner, only `* -> 'resolved'` **evidenced** (0067), else service-role | — |
| `fdh_transaction_links` | entire table | owner (RLS) | **service-role only** (0067: was previously unguarded since FDH-1) | owner, only `status: pending -> confirmed/rejected` + `user_confirmed` alongside `confirmed` (0067); all other fields service-role only | owner (unchanged, rare) |
| `fdh_recurring_transactions` | entire table | owner (RLS) | **service-role only** (0067: was previously unguarded since FDH-1) | owner, only the transitions in `ALLOWED_SERIES_TRANSITIONS` + `user_confirmed=true` (0067); all other fields service-role only | owner (unchanged, rare) |
| `fdh_classification_history` | `changed_by_type` | owner (RLS, SELECT-only) | owner, **restricted to `changed_by_type='user'`** (0067: was previously content-unrestricted); service-role may insert any value | — (append-only, unchanged since FDH-1) | — |
| `fdh_user_classification_rules` | entire table | owner (RLS) | owner (unchanged — by design, this IS the user's own data) | owner (unchanged) | owner (unchanged) |

## 3. Valid-FK same-user forgery attempts (spec section 60) — all BLOCKED

Using the owning user's OWN valid transaction/link/series ids (never a
guessed or cross-tenant id):

1. `economic_transaction_type` bare forgery (no correction row) — BLOCKED
2. `category_id` bare forgery — BLOCKED
3. `classification_confidence` forgery — BLOCKED outright
4. `classification_method` forgery — BLOCKED outright
5. `recurring_flag` forgery — BLOCKED outright
6. `transfer_flag` forgery — BLOCKED outright
7. `review_status` forgery to `resolved` with no correction evidence — BLOCKED
8. `recurring_transaction_id` forgery — BLOCKED outright
9. `fdh_transaction_links` direct INSERT of a forged `confirmed` link — BLOCKED
10. `fdh_transaction_links.confidence` forgery on an existing link — BLOCKED
11. `fdh_transaction_links.status` illegitimate transition (`pending -> superseded`) — BLOCKED
12. `fdh_recurring_transactions` direct INSERT — BLOCKED
13. `fdh_recurring_transactions.frequency` forgery — BLOCKED
14. `fdh_recurring_transactions.status` illegitimate transition (`active -> candidate`, moving backward) — BLOCKED
15. `fdh_classification_history` fabricated `changed_by_type='system'` audit row — BLOCKED

## 4. Legitimate user writes proven allowed (spec section 61)

1. **Evidenced correction**: insert a `fdh_transaction_corrections` row,
   then the matching `fdh_transactions` UPDATE succeeds and durably
   persists — proves the already-shipped `correctTransaction()` feature
   keeps working after the hardening.
2. **Transfer link review**: `pending -> confirmed` with `user_confirmed
   =true` succeeds.
3. **Recurring series review**: `candidate -> active`, `candidate -> ended`,
   `active -> paused` all succeed (the exact transitions
   `classificationReviewService.ts` exposes).
4. **Self-attested audit row**: a `changed_by_type='user'`
   `fdh_classification_history` insert succeeds.

## 5. Cross-user security (spec section 62)

Real Tenant A / Tenant B rows (not synthetic placeholders):

- Tenant B cannot read Tenant A's transactions, transaction links, or
  recurring series (RLS `SELECT`).
- Tenant B's UPDATE against Tenant A's transaction affects **0 rows** (RLS
  hides the row entirely — the correct Postgres behaviour for a denied
  UPDATE is silent non-match, not an exception; the certification script
  verifies this via `affectedRows`, not merely "no error", and separately
  re-reads Tenant A's row to prove it is byte-identical afterward).
- Tenant B's attempted review of Tenant A's transaction link likewise
  affects 0 rows.

## 6. Global reference security (spec section 63)

Unchanged from FDH-2, re-confirmed by inspection: `fdh_categories`,
`fdh_subcategories`, `fdh_merchants`, `fdh_merchant_aliases`,
`fdh_classification_rules` carry no INSERT/UPDATE policy for
`anon`/`authenticated` at all (FDH-1/FDH-2 RLS, untouched by migration
0067). R8 adds no new global reference table.

## 7. R7 fact protection (spec section 64)

Migration 0067 touches only R8's own newly-authoritative columns and two
tables (`fdh_transaction_links`, `fdh_recurring_transactions`) that had no
real writer before R8. It does not alter `trg_r7_transaction_authoritative_
fields`'s existing R7 guard clauses (dedup/provenance fields, `dedup_
status` transition) and does not touch `fdh_statement_uploads`'s trigger at
all. `amount_original`, `currency_original`, `transaction_date`, `source_
account` (`financial_account_id`), `description_raw`/`description_clean`
(outside the FDH-3/R7 correction path, unchanged), `source_reference`, and
provenance columns (`parser_version_id`, `source_row_hash`, `economic_
fingerprint*`) remain exactly as protected as R7 left them.

## 8. Negative control (spec section 73-class requirement, applied to security)

`scripts/r8_security_certification.mjs` builds TWO databases: one replaying
migrations through `0066` only (no R8 hardening) and one through `0067`
(with it). The identical forgery attempt — a bare
`economic_transaction_type` PATCH — **succeeds** against the pre-0067
database (RED, proving the test can actually fail) and is **blocked**
against the post-0067 database (GREEN). This is the same discipline
`scripts/r7final_reconciliation_status_forgery_negative_control.mjs`
established for R7's own equivalent gap.

Two genuine defects were found and fixed while building this
certification (not merely simulated for this document):

1. **Migration gap**: `candidate -> ended` was a valid application-layer
   transition (`classificationReviewService.ts`) that the migration
   0067 trigger did not yet permit — found by the certification script,
   fixed in the same migration file before this release closed.
2. **Test-harness bug**: a nested `asRole()` call inside another
   `asRole()` callback left the `request.jwt.claims` GUC pointing at the
   wrong tenant after the inner call unwound (`reset role` restores the
   Postgres role but not the session GUC), producing a false PASS on a
   cross-tenant check. Fixed by never nesting `asRole()` calls and by
   `asRole()` itself now resetting the claims GUC in its own `finally`
   block as defense in depth.

## 9. What remains open (disclosed)

- **Live DEV/production security certification has not been performed** —
  migration 0067 is not applied anywhere outside this session's PGlite
  sandboxes (no DDL-execution credential in this environment). This is the
  same disclosed constraint every prior FDH phase in this environment has
  carried; a follow-up session with the Product Owner's manual migration
  application should re-run `scripts/r8_security_certification.mjs`'s
  scenarios as live queries, mirroring how `0065`'s fix was independently
  reproduced live after application.
