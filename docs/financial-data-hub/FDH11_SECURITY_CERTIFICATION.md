# FDH-11 — Security Certification

## PGlite DB certification (`scripts/fdh11_certification.mjs`) — 20/20 PASS

Run against real Postgres (PGlite), full migration replay (all 100 migrations, fresh DB), `set_config('request.jwt.claims', ...)` + `set role <role>` to genuinely exercise RLS and the authoritative-write triggers, real multi-tenant data.

| # | Check | Result |
|---|---|---|
| 1 | Migration replay: every migration applies cleanly on a fresh DB | PASS |
| 2 | Schema: `fdh_investment_statements`/`_positions`/`_activities` exist with RLS enabled; `ii_instrument_identifiers.identifier_scheme` present | PASS (4/4) |
| 3 | Same-tenant authority: `authenticated` cannot forge `approval_status` / position `apply_status`+`canonical_holding_snapshot_id` / activity `apply_status`+`canonical_transaction_id` / `security_match_status`+`matched_instrument_id`; service-role CAN write `approval_status` (real path proven) | PASS (6/6) |
| 4 | Cross-tenant: Tenant B cannot read Tenant A's statement (RLS); Tenant B's write has no effect; foreign `statement_upload_id` blocked; foreign `linked_transaction_id` (bank transaction) blocked | PASS (4/4) |
| 5 | `asx_ticker` identifier scheme: insertable with `country_code`; rejected without one (country-scoped, not global); duplicate value within AU rejected (country-scoped uniqueness) | PASS (3/3) |
| 6 | `ii_transactions.uidx_ii_transactions_fingerprint`: second insert with the same `(account_id, transaction_fingerprint)` rejected by the DB — the real backstop `applyAuStatementActivity.ts`'s race-handling relies on | PASS |
| 7 | Harness self-check: with the authoritative-write guard trigger surgically removed in an isolated throwaway DB, the SAME forgery attempt from check 3 SUCCEEDS — proving check 3 is not a vacuous test | PASS |

Full console output is reproducible by running `node scripts/fdh11_certification.mjs` (requires `npm i --no-save @electric-sql/pglite`, same ad hoc pattern every prior PGlite-based certification in this repository uses).

## Same-tenant authority (spec section 85)

Proven live (item 3 above), not theorised. A user cannot forge, merely by owning the row: statement `approval_status`, position/activity `apply_status`, `matched_instrument_id`, `canonical_account_id`/`canonical_transaction_id`/`canonical_holding_snapshot_id`, `security_match_status`, or `bank_match_status`/`linked_transaction_id`.

## Cross-tenant security (spec sections 86-88)

Tenant A/B: **4/4** attack vectors tested and blocked (statement read, statement write-no-effect, foreign investment-account-adjacent reference via `statement_upload_id`, foreign bank-transaction reference via `linked_transaction_id`). Foreign investment account: **BLOCKED** (ownership guard trigger rejects a statement referencing another tenant's upload; the bridge's own `applyAuStatementActivity.ts` additionally re-verifies `ii_accounts.user_id` matches the caller before writing, a defence-in-depth check beyond what the trigger alone requires). Foreign bank transaction: **BLOCKED**.

## Global security integrity (spec section 89)

`ii_instruments`/`ii_instrument_identifiers` carry no authenticated write policy — unchanged by FDH-11's additive `asx_ticker` scheme widening. The only creation path (`createProvisionalAuSecurity()`) reuses II's own `resolveOrCreateInstrument()` governance function, gated behind the bridge's service-role client, itself only reachable after an explicit user "confirm new security" action in the review UX.

## PII minimisation (spec sections 19-20)

`fdh_investment_statements.masked_account_identifier` carries a DB-level check constraint (`chk_fdh_investment_statements_masked_identifier`) rejecting any value containing 7+ consecutive digits — the same discipline `fdh_liability_statements`/`fdh_financial_accounts` already established, backstopping the API-layer Zod validation (`auInvestmentStatementUploadMetadataSchema`) that performs the identical check before the value ever reaches the database.

## Bundle security scan (spec section 151)

Production build (`npx next build`) completed with zero errors, all 8 new `investment-statement` API routes compiled. Scan of `.next/static` (99 JS chunk files): 0 occurrences of the literal `SUPABASE_SERVICE_ROLE_KEY` value, 0 occurrences of `createAdminClient` (confirming no service-role-touching code leaked into a client bundle), 0 occurrences of any dev/test credential created during this pass, 0 files matching a 10+-digit sequence under any investment-named chunk (no full HIN/broker-account-number pattern). Raw statement content is never sent to the client bundle by construction (extraction happens server-side in `investmentStatementProcessingService.ts`; the client panel only ever receives already-redacted evidence-row JSON).

## Live-DEV re-proof (spec sections 84-89, 106-107, 121-123) — completed in a follow-up closure round

After the Product Owner applied migration `0106` to DEV (Supabase SQL Editor), every security control above was re-proven live against real hosted Postgres via `scripts/fdh11_live_dev_certification.mjs`: same-tenant authoritative forgery (real Tenant-A JWT, direct PostgREST `PATCH`, HTTP 400 with the trigger's own message), cross-tenant isolation (real Tenant-B JWT, empty read), foreign investment account (HTTP 400), foreign bank transaction (HTTP 400), global security-master mutation (real Tenant-A JWT, direct `POST .../ii_instruments`, HTTP 403), duplicate statement, overlapping statements (fingerprint dedup to the pre-existing canonical row), No Apply, concurrent Apply (two simultaneous requests, exactly one canonical row), and stale/conflict — all 43 checks in that script PASS. Full detail and exact request/response evidence in `FDH11_LIVE_DEV_CERTIFICATION.md`.

A real bug was found and fixed during this live pass: the security-match route selected a column (`exchange`) that exists only on `fdh_investment_statement_positions`, not on `fdh_investment_statement_activities` — PostgREST rejected the query for activity rows, and the route mistook the resulting query error for "row not found" (a 404). Fixed by selecting per-table and surfacing genuine query errors instead of masking them. This is exactly the kind of defect PGlite certification, which exercises schema/RLS/triggers but not the full HTTP route layer end-to-end, cannot catch — underscoring why the live-DEV pass was necessary, not merely confirmatory.
