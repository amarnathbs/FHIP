# Production hotfix: `ii_holding_snapshots` same-user authoritative-forgery fix (migration `0094`)

**Extracted deliberately from `0092` ("II R12 — Wider India Assets") as a standalone, security-only migration** — `0092` bundles this genuine security fix with unrelated R12 feature schema (a widened `ii_transactions.transaction_type` constraint, a new `ii_holding_snapshots.price_source` column, a widened `ii_scheme_tax_classification.basis` constraint). R12's own feature certification is not yet complete and its application code is not production-ready. This fix, by contrast, is fully certified and closes a real, independently-reproduced vulnerability on an already-live production table — it should not wait on R12's timeline.

## What's wrong, right now, in production

`ii_holding_snapshots` currently uses a blanket `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)` RLS policy — the same recurring defect class this project has now found and fixed five times elsewhere (`0065`, `0069`, `0087`, and this same day's SMSF `0090` and Goal Linkage `0093` fixes). Row ownership is enforced, but every column on an owned row is freely writable by the owning user — including `current_value`/`units`, which are meant to be exclusively system-derived (statement parsing, admin-client recomputation), never a direct user edit.

**Independently reproduced live, today, against real DEV** (not theoretical): an authenticated owner PATCHed their own holding snapshot's `value` to `999999999` — genuine `HTTP 200`, genuinely persisted, then restored via service role. `ii_holding_snapshots` also exists in production (confirmed via read-only REST) — this defect class is schema-level, not DEV-specific, so it is reasonably suspected to also be live in production, though not behaviorally confirmed there (that would require creating synthetic data in production, not done without your separate authorization).

## The fix

A full grep of `app/` + `lib/` for `.insert(/.update(/.upsert(` against `ii_holding_snapshots` finds **zero** authenticated-client call sites — every real write goes through `createAdminClient()` in `manualImporter.ts`/`documentProcessing.ts`/`investmentPublicationService.ts`. There is no legitimate authenticated write path to preserve. The fix replaces the policy with SELECT-only for the owner — no INSERT/UPDATE/DELETE policy for authenticated at all, matching `0087`'s `ii_transactions` shape exactly.

## Verification performed

- **PGlite** (`scripts/r12_post_migration_pglite_verification.mjs`, run against a tree with this exact SQL applied): 11/11 passed, including a genuine RED→GREEN negative control (reintroducing the old policy proves the forgery really would succeed, restoring proves the fix is real, not vacuous).
- **Live DEV** (`scripts/r12_live_dev_verification.mjs`): reproduced the forgery live against real DEV with a real synthetic user and real JWT — `HTTP 200`, value forged to `999999999`, then restored. This proves the *pre-fix* vulnerability is real; the fix itself has not yet been applied to DEV (same standing limitation as every release this session — no DDL execution capability in this environment).

## How to apply

1. Run `01_0094_ii_holding_snapshots_authoritative_forgery_hotfix.sql` in the production Supabase SQL Editor. It is self-contained (`begin; ... commit;`), idempotent (`drop policy if exists` / unconditional `create policy`), and does not touch any other table or column.
2. Run `02_production_verification.sql` — Part A is read-only (confirms the new policy exists, confirms no ALL/UPDATE/INSERT/DELETE policy remains for `authenticated`), Part B is a self-cleaning behavioral check using a synthetic user (wrapped in a transaction that always rolls back).
3. Paste the output back — I'll independently verify it, same as every other release this session.

## Explicitly not touched by this hotfix

`0092`'s other three changes (widened `transaction_type` constraint, `price_source` column, widened tax-classification `basis` constraint) are **not** included here and remain unapplied to production — they're inert, additive schema that nothing reads/writes until R12's application code ships, so there's no urgency to apply them ahead of R12's own release.
