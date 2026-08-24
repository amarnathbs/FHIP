# FDH-8 — Security Certification

## Tenant isolation (spec 73-76, 116-118)

FDH-8 adds **zero new tables and zero new RLS policies** — it reads exclusively through the existing `auth.uid() = user_id` policies on `fdh_transactions`, `fdh_transaction_allocations`, `fdh_transaction_links`, `fdh_financial_accounts`, `fdh_recurring_transactions`, `fdh_duplicate_candidates`, `fdh_statement_uploads` (all unmodified by this phase), plus public-read master data (`fdh_categories`, `fdh_subcategories`, `fdh_merchants`, which carry no user-specific data). Every FDH-8 query additionally applies an explicit `.eq('user_id', userId)` (or, for account-scoped reads, `.eq('financial_account_id', accountId)` layered on top of the user filter) — defence in depth matching every other FDH repository's convention.

`scripts/fdh8_certification.mjs` SECTION 2 (real PGlite Postgres, RLS genuinely evaluated via `set role authenticated` + JWT claims):

```
  PASS  Tenant A querying with a forged Tenant-B account_id gets zero rows (server derives user_id, RLS blocks the rest)
  PASS  RLS alone (no app-layer user_id filter) still blocks Tenant A from Tenant B's account
  PASS  Tenant A cannot read Tenant B's account row directly by forged id
  PASS  control: Tenant B genuinely can see their own account's transaction (RLS is not blocking everything)
```

The second check is the important one: it proves isolation holds even if a future FDH-8 code change forgot the application-layer `user_id` filter — RLS is the actual enforced boundary, not just application discipline. `user_id` for every FDH-8 query is derived server-side from `requireUser()` → `supabase.auth.getUser()` (cookie session), never trusted from a client-supplied parameter — confirmed by reading every route under `app/api/financial-data-hub/activity/`: none of them accepts a `user_id`/`household_id` query parameter at all.

## Client-bundle secret leakage (spec 118)

`financialActivityAnalytics.ts` imports `@/lib/supabase/server` (the cookie-based, anon-key server client) exclusively — it never imports `createAdminClient`/a service-role client. Confirmed by grep: zero occurrences of `SERVICE_ROLE` or `createAdminClient` in `lib/financial-data-hub/analytics/**` or `app/api/financial-data-hub/activity/**`.

A `.next/static` scan for `SUPABASE_SERVICE_ROLE_KEY` and `createAdminClient` client-bundle matches requires a completed production build; see the build-verification evidence gathered during UI integration (reported in the completion report's Regression section) for whether this was run against the final build output in this session.

## No admin transaction browser (spec 72)

FDH-8 introduces no admin route. Every route under `app/api/financial-data-hub/activity/` calls `requireUser()` and operates only on the authenticated user's own data — there is no endpoint that accepts an arbitrary `user_id`/`household_id` and returns another user's aggregates.

## No raw document access as a core feature (spec 71)

FDH-8 never queries `fdh_statement_uploads.raw_document_storage_reference` or any storage bucket — `getOverview()`'s only read of `fdh_statement_uploads` is `updated_at` for the freshness line (`select updated_at ... where processing_status='approved'`), no document bytes or storage reference. Confirmed by grep: `financialActivityAnalytics.ts` never imports `lib/financial-data-hub/services/storage.ts`.

## Logging (spec 118)

No `console.log`/`console.error` of a raw transaction row, merchant history, account-level total, or user financial figure exists in `financialActivityAnalytics.ts` or the `activity/*` API routes (grep-verified: the only `throw new Error(...)` calls in the file carry a static prefix + the Postgres error message, never a dollar amount or row payload).

## Open residual (not closed by FDH-8, correctly not claimed as closed)

FDH1-F1 (the previously-disclosed FK-bypasses-RLS residual) remains open per standing instruction — FDH-8 introduces no new sensitive FK relationship and does not attempt to remediate it.
