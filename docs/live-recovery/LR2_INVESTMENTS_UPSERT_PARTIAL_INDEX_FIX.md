# LR-2 CRITICAL FINDING: adding an Investment via the catalogue picker was completely broken — live in production (2026-09-10)

## Severity

**P0/P1 — live production defect, currently affecting every user.** Confirmed via a read-only check against the production database (`source_type` column present on `investments`) that the same schema is live in production right now — meaning any real user attempting to add a manual Investment through the normal catalogue picker (Australian Shares, ETFs, Managed Funds, etc. — the primary, most common way to add an investment) has been hitting a hard failure since migration `0042` was applied, with no workaround via the UI.

## How it was found

Certifying LR-2's disclosed gap (per-module Add/Edit/Cancel/Delete/reload sign-off across all 8 registers, per the PO's own review) with a real live-DEV browser walkthrough. Income, Expenses, Assets, and Liabilities all passed cleanly. Investments failed immediately: selecting "ETFs" from the catalogue and clicking Save produced a real, persistent error banner:

> ⚠ there is no unique or exclusion constraint matching the ON CONFLICT specification — try Save again.

The app's own retry logic (visible in the UI) attempted the same request twice and gave up, correctly reporting the failure rather than silently swallowing it — but the underlying operation can never succeed regardless of how many times it's retried, since the cause is a schema/query mismatch, not a transient condition.

## Root cause

`lib/services/registry.ts`'s generic `makeRegistry(table).save()` — shared by all 7 `FinancialDataGrid` registers — saves a catalogue-linked row via:

```ts
supabase.from(table).upsert({ ...row, user_id: userId, is_active: true }, { onConflict: 'user_id,master_item_key' })
```

This relies on Postgres inferring a matching unique constraint/index from the `(user_id, master_item_key)` column list alone. That works for every register **except `investments`**, because migration `0042_ii_r3_fhip_publishing_bridge.sql` (built for the Investment Intelligence R3 FHIP-publishing bridge, so a manually-entered investment and an Investment-Intelligence-published one can coexist under the same `master_item_key` without colliding) deliberately replaced `investments`' original table-wide unique constraint with a **partial** unique index:

```sql
alter table investments drop constraint uq_investments_user_master;
create unique index uidx_investments_user_master_manual
  on investments(user_id, master_item_key)
  where source_type = 'manual';
```

Postgres will only match an `ON CONFLICT` target against a partial index if the statement's own `ON CONFLICT` clause repeats the exact same `WHERE` predicate (`ON CONFLICT (user_id, master_item_key) WHERE source_type = 'manual' DO UPDATE ...`). PostgREST's `upsert()` `on_conflict` query parameter has no mechanism to express that predicate — it only accepts a column list — so every upsert against `investments` fails with Postgres error `42P10` ("no unique or exclusion constraint matching the ON CONFLICT specification"), unconditionally, for every user, every time.

`assets` and `retirement_accounts` received the same new `source_type` column in the same migration (its own §3 comment: *"the SAME structural source markers"*), but their original table-wide unique constraints were deliberately left untouched (*"No R3 production write path targets these tables' new columns"*) — confirmed by re-reading the migration in full. **Only `investments` has this partial-index shape**, which is exactly why Assets/Liabilities/Income/Expenses all passed their own equivalent live tests cleanly moments earlier in the same certification pass.

## Why this was never caught before

`lib/services/registry.ts` has **zero dedicated unit-test coverage** — confirmed by search — so its `save()` method's actual SQL-level behavior against a real (or even PGlite-simulated) Postgres schema has never been exercised by `npm test`. The original LR-2 phase report's own live-DEV pass tested Investments only for its `notApplicable` checkbox, never for adding a real catalogue item — the one path this bug lives in. This mirrors the exact pattern already found twice earlier in this session's closure work (LR-9's storage-purge discriminator, this same day): a defect invisible to mocked/unit tests, caught only by a real action against the real database.

## The fix

`lib/services/registry.ts` — `save()` now special-cases tables with this partial-index shape (currently just `investments`, tracked in a `PARTIAL_MASTER_KEY_INDEX_TABLES` set for any future table needing the same treatment) by explicitly mirroring the partial index's own scope instead of relying on native upsert:

1. Look up an existing row for `(user_id, master_item_key)` **filtered to `source_type = 'manual'`** — the exact predicate the partial index itself uses.
2. If found, `UPDATE` that row by `id`.
3. If not found, `INSERT` a new row with `source_type: 'manual'` set explicitly.

This preserves the exact behavior migration `0042` intended (a manual row and an Investment-Intelligence-published row sharing a `master_item_key` never collide — confirmed by a dedicated test) while making the "re-check a catalogue item resurrects it instead of duplicating" contract genuinely work, which it never did for this table. Every other register's `save()` path is completely unchanged.

## Verification

- **Live-DEV, before the fix**: reproduced the exact production-shaped failure — selecting "ETFs," entering a value, and clicking Save failed with the identical Postgres error, confirmed via the real `GET /api/dashboard`-adjacent Investments page against real DEV.
- **Live-DEV, after the fix** (same browser session, same form, hot-reloaded): Add succeeded (`ETFs, Child, $3,000.00, AUD`); Edit → Save → full-page reload confirmed `$3,500.00` persisted with `Owner: Child` preserved; Remove returned the register to its correct empty state.
- **6 new unit tests** (`tests/unit/registryInvestmentsPartialIndexFix.test.ts`): a new manual row inserts correctly with `source_type: 'manual'` explicitly set; re-saving the same `master_item_key` updates the existing manual row in place rather than duplicating it; a coexisting Investment-Intelligence-published row under the same `master_item_key` is correctly left untouched and NOT matched (proving the exact coexistence guarantee migration 0042 was built for still holds); a same-key row belonging to a different user is never cross-matched; `assets` (a table without this quirk) is confirmed still using the original native-upsert path unchanged; a custom (no `master_item_key`) item still always inserts on any table.
- `tsc --noEmit` and `eslint` clean. Full unit suite and production build both re-run clean (see commit for exact counts).
- **Production impact confirmed via a read-only check**: `investments.source_type` exists in the production database, confirming migration `0042` — and therefore this exact defect — is live in production today.

## Recommended next step

This is a pure, isolated, additive bug fix with no schema change, no UI change, and zero effect on the 6 other registers (all independently re-verified unaffected). Given it is currently broken in production for every user attempting to add a manual investment via the catalogue picker, it is a strong candidate for an expedited path to `main`/production ahead of the rest of the LR-2 certification pass finishing — flagged to the PO for that decision rather than assumed.
