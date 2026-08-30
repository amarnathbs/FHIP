# MCC-14 Fix — Cascade-Aware DELETE Exception — Closure Report

**Date:** 2026-08-30
**Repository:** `D:\FHIP`, branch `feature/mandatory-country-confirmation-beta-cleanup`, worktree `D:\fhip-country-confirm`
**Supersedes/extends:** `Mandatory_Country_Confirmation_Beta_Cleanup_Report_2026-08-29.md` section U (MCC-14 discovery, round 4)
**Type:** Product-Owner-directed fix for the sole remaining Gate A blocker (MCC-14), with an explicit, verbatim required design.

## A. What changed

Migration `0111_mandatory_country_confirmation_delete_cascade_fix.sql` implements exactly the rule the Product Owner specified:

```
INSERT or UPDATE                                -> require confirmed country
DELETE where auth.users row still exists        -> ordinary direct deletion; require confirmed country
DELETE where auth.users row no longer exists    -> account-deletion cascade; allow
```

- A new, minimal `SECURITY DEFINER` helper, `public._mcc_auth_user_exists(uuid)`, reads only whether a given id exists in `auth.users` — nothing else. `EXECUTE` is revoked from `public`/`anon`/`authenticated`/`service_role`; it is never exposed to PostgREST and is callable only by the `SECURITY DEFINER` trigger functions in this migration.
- `enforce_country_confirmed()` (the generic trigger backing 82 tables) gets one new early-exit branch: on `DELETE`, if `_mcc_auth_user_exists(old.user_id)` is false, allow unconditionally — checked *before* the households onboarding exemption and *before* `is_country_confirmed()`, both of which read `user_profiles`, the exact table whose cascade-order-dependent absence caused MCC-14. Everything else (the `service_role` bypass, the households INSERT/UPDATE onboarding exemption, the confirmation gate itself) is byte-for-byte unchanged from migration `0108`.
- `enforce_country_confirmed_via_twin_run()` (the bespoke join trigger for `financial_twin_insights`/`financial_twin_metric_results`) gets the identical exemption, keyed off the owner resolved via the join to `financial_twin_runs`, as an explicit, ordering-independent guarantee (its own pre-existing "no matching parent run → allow" branch already tolerated the nested-cascade case, but the new check removes the need to reason about that implicitly).
- `professional_notes`' bespoke owner-column trigger (`enforce_country_confirmed_professional_notes()`) and the three UPDATE-only bespoke tables (`ii_reconciliation_cases`, `ii_review_items`, `professional_profiles`) needed no change — none of them carries a `DELETE` trigger at all (confirmed via `scripts/mcc_crud_policy_inventory.mjs`'s CRUD inventory), so they can never be reached during a DELETE cascade in the first place.

Nothing about the blanket-exemption approach originally proposed (and rejected by the Product Owner) survives in this design: an unconfirmed user's direct `DELETE` on their own pre-existing row is still fully gated (Proof 4 below), because their `auth.users` row still genuinely exists at that moment. The exemption never keys off `service_role`, `supabase_auth_admin`, or DELETE-as-a-whole — only the owning `auth.users` row's own absence, re-checked fresh per row via the narrow helper, independent of table or cascade position.

## B. Migration numbering

Before writing the file, every local branch/worktree and every branch on `origin` was scanned for existing `supabase/migrations/0*.sql` files (see `docs/architecture/MIGRATION_REGISTRY.md`'s new "MCC-14 DELETE-cascade fix (migration `0111`)" section for the full table of commands run and their results). Numbers `0103` through `0110` were all already claimed by something — this branch's own `0104`/`0105`/`0108`; `fix/g0-wave2-closure-hotfix`'s local, unauthorised `0103`; the now-merged `feature/fdh11-au-investment-statement-intelligence`'s `0106`; `fix/admin-a02-wave1-recommendation-import-integrity`'s pushed `0107` and `0109`; and `feature/module-11-0-ai-foundation`'s local, unmerged `0110`. **`0111` is the first genuinely free number.** `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` confirms zero collision after allocation.

## C. Certification — real Postgres (PGlite), all 11 required proofs

Two scripts:
- `scripts/mcc14_delete_cascade_certification.mjs` (new, this fix) — the 11 proofs below.
- `scripts/mcc_pglite_certification.mjs` (existing, re-run unmodified) — Proof 9, zero-regression check.

Both replay the full migration chain (`0001`-`0111`) from empty against a real Postgres engine (PGlite/WASM), the same established harness pattern (`scripts/db-rebuild-check/shim.sql`) used throughout this project, including for MCC-14's own original discovery.

| # | Required proof | Result | Evidence |
|---|---|---|---|
| 1 | Confirmed-user account deletion succeeds | **PASS** | `U_CONFIRMED` (genuinely `CONFIRMED`, seeded with a real row in 84 of the 85 backstopped tables — see finding below for the 85th) deleted via `DELETE FROM auth.users` issued with no JWT/role context (the same no-session approximation of the real Admin API used in the original MCC-14 diagnostic). Succeeded with no exception; `auth.users` and `user_profiles` rows both confirmed gone afterward. |
| 2 | Unconfirmed-user account deletion succeeds | **PASS** | `U_UNCONFIRMED` (`onboarding_completed=true`, `country_confirmed_at=null`) with real `assets`/`user_goals` rows deleted cleanly; rows confirmed cascaded, zero orphans. |
| 3 | Missing-country account deletion succeeds | **PASS** | `U_MISSING` (`country_of_residence=null`) with a real `expense_items` row deleted cleanly; row confirmed cascaded. |
| 4 | Direct DELETE by an unconfirmed user remains blocked | **PASS** | `U_DIRECT_A` rolled back to unconfirmed while their `auth.users` row still genuinely exists; a direct `DELETE` on their own pre-existing `assets` row was rejected with the real `COUNTRY_CONFIRMATION_REQUIRED`/`42501` error, and the row was independently confirmed still present afterward. This is the core requirement the whole fix exists to preserve, proven directly — not inferred from "the INSERT/UPDATE-only exemption would have broken it." |
| 5 | Direct DELETE by a confirmed owner remains allowed where RLS permits | **PASS** | The same `U_DIRECT_A`, now confirmed, successfully deletes the same row; row confirmed gone. |
| 6 | Cross-tenant DELETE remains blocked | **PASS** | A different, confirmed tenant (`U_DIRECT_A`) attempting to delete `U_DIRECT_B`'s row affects 0 rows (RLS's pre-existing `auth.uid() = user_id` policy, untouched by this fix); row confirmed untouched. |
| 7 | All ~85 protected tables cascade without obstruction during a real account deletion | **PASS, with one disclosed, unrelated, out-of-scope finding** | A real row was dynamically seeded (via an information_schema-driven fixture builder, not a hand-picked sample) for `U_CONFIRMED` in **84 of the 85** backstopped tables, then all 84 cascaded cleanly on account deletion. The 85th, `professional_notes`, was deliberately seeded with a *different* user as author — see finding below; it is not a DELETE-trigger/MCC-14 issue at all. |
| 8 | No orphaned rows remain after a real account deletion | **PASS** | A full post-delete scan of all 84 owner-swept tables (plus the external `professional_relationships` support row) found zero rows still referencing `U_CONFIRMED`. |
| 9 | Existing INSERT/UPDATE controls remain unchanged | **PASS** | `scripts/mcc_pglite_certification.mjs` re-run unmodified against the tree now including `0111`: **58/58**, identical to before this fix. `scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs` **73/73**, `wave2_catalogue_applicability_cert.mjs` **70/70**, `rls.mjs` **25/25** — all unchanged. |
| 10 | A failed account deletion remains atomic | **PASS** | A temporary, unrelated failing trigger was attached to `user_goals` for one fixture user (`U_ATOMIC`) to force a genuine mid-cascade failure independent of country confirmation. The whole `DELETE FROM auth.users` statement aborted; `auth.users`, the `assets` row, and the `user_goals` row were all independently confirmed still present afterward (nothing half-deleted) — a real Postgres single-statement-atomicity guarantee, now proven to hold with `0111`'s triggers participating in the cascade. Cleanup: the same user then deleted cleanly once the injected failure was removed. |
| 11 | Repeated/already-deleted-account deletion is handled safely | **PASS** | Re-issuing `DELETE FROM auth.users` for the already-deleted `U_CONFIRMED` affected 0 rows, no error, no crash. A second scenario (a backstopped row already independently removed before the account-level delete ran) also completed cleanly. |

**Full run: 31/31 checks passed, 0 failed** (`node scripts/mcc14_delete_cascade_certification.mjs`).

## D. Disclosed, out-of-scope finding: `professional_notes.author_user_id` has no `ON DELETE CASCADE`

Found incidentally by Proof 7's exhaustive full-table sweep, independently reproduced twice (once from the schema definition, once live in PGlite):

- `professional_notes.author_user_id references auth.users(id)` (migration `0083`, line 327) carries **no** `on delete cascade` — unlike every other owner-style FK in the 85-table backstop set.
- `professional_notes.relationship_id references professional_relationships(id)` **does** cascade. So deleting the **client** side of a professional relationship correctly cascades `professional_relationships` → `professional_notes` (verified live: `U_CONFIRMED`, the client in the fixture, deleted cleanly, and their relationship's note cascaded away too).
- Deleting the **professional** (`author_user_id`) side, while they still have an authored note, fails with a bare Postgres FK violation (`professional_notes_author_user_id_fkey`) — reproduced live, confirmed via the exact error text that this is **not** `enforce_country_confirmed()` (no `COUNTRY_CONFIRMATION_REQUIRED` anywhere in the error). Deleting the note first, then the professional, succeeds normally.
- **This is not an MCC-14 defect and migration `0111` does not touch it.** `professional_notes` carries no `DELETE` trigger of any kind (`enforce_country_confirmed_professional_notes()` fires `BEFORE INSERT` only), so `enforce_country_confirmed()`/`0111`'s new branch is never even reached during this failure — it is a plain, pre-existing FK cascade-policy gap, unrelated to country confirmation.
- **Not fixed here**, deliberately: whether a professional's authored notes about a client should be deleted, reassigned, or anonymized when the professional's own account is deleted is a product decision, not a schema bug this session is authorised to resolve unilaterally. Flagged for separate Product Owner attention.

## E. What this certification does NOT cover, and why

Per this project's standing policy, **migration `0111` was not applied to DEV or production by this session**, and no direct DDL was executed against any hosted environment. Consequently, the "actual Supabase Admin deletion API against real DEV" portion of the required proof could not be performed against the *fixed* trigger — DEV currently still runs the pre-`0111` trigger (only `0104`/`0105`/`0108` are live there), so exercising the real Admin API against DEV right now would only re-reproduce the already-documented MCC-14 bug, not prove the fix. Re-creating and deleting synthetic DEV users solely to re-confirm an already-proven, unfixed bug was judged not to add genuine value and was not done.

All 11 proofs above were therefore established via PGlite — real Postgres, the same evidentiary bar this project used to establish MCC-14's own root cause in the first place (closure report section U: "independently confirmed via a fresh PGlite reproduction... not just inferred from the live symptom"). **Once the Product Owner applies migration `0111` to DEV** (same manual Supabase-SQL-Editor process as `0104`/`0105`/`0108`), the live-DEV Admin-API portion of this proof — recreating the exact 3-user MCC-14 reproduction from round 4's closure report and confirming all three now delete cleanly — should be re-run and independently verified, following the identical pattern Gap 3 used for those three earlier migrations.

## F. Files changed

- `supabase/migrations/0111_mandatory_country_confirmation_delete_cascade_fix.sql` (new)
- `scripts/mcc14_delete_cascade_certification.mjs` (new — the 11-proof certification)
- `docs/architecture/MIGRATION_REGISTRY.md` (allocation record)
- `docs/jurisdiction-applicability/MCC14_Fix_Closure_Report_2026-08-30.md` (this file)

No application code changed. No migration applied to DEV or production. Not pushed, not merged, not deployed.

## G. Verdict

**MCC-14: FIXED and certified in isolation (PGlite, 31/31), with zero regression to the existing 58/58 + 73/73 + 70/70 + 25/25 certified suites.** Gate A's sole remaining blocker per the round-4 closure report is resolved pending the Product Owner's manual application of `0111` to DEV and the live-DEV re-verification described in section E. One new, unrelated, out-of-scope defect (`professional_notes.author_user_id` FK cascade gap, section D) was found and disclosed, not fixed, for separate Product Owner decision.
