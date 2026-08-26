# Production hotfix: `goal_funding_sources` cross-tenant authoritative-forgery fix (migration `0095`)

**Extracted deliberately from `0093`** ("Education Fund / Children Investment → Goal Linkage") **as a standalone, security-only migration** — matching the same pattern just used for `0094` (`ii_holding_snapshots`). `0093` bundles this genuine security fix with unrelated Goal Linkage feature work (retiring `education_fund`/`children_investment` from new-investment creation, and a conservative deterministic backfill). Goal Linkage's own feature certification and UI are a separate release with their own timeline. This fix, by contrast, is fully certified and closes a real, independently-reproduced vulnerability on an already-live production table (migration `0009`) — it should not wait on Goal Linkage's timeline.

## What's wrong, right now, in production

`goal_funding_sources`' original RLS policy was `auth.uid() = user_id` on both `USING` and `WITH CHECK` — it never verified that the *referenced* `goal_id`/`linked_asset_id`/`linked_investment_id`/`linked_retirement_id` actually belonged to that same user. A user whose own `user_id` is legitimately their own could still reference another tenant's goal or another tenant's asset/investment/retirement row purely by guessing its UUID — the foreign key only proves the row exists, not who owns it (the same class of gap that produced the `0078` Property↔Liability fix).

**Independently reproduced live, today, against real DEV**: Tenant A linked their own goal to Tenant B's *private* investment using only Tenant A's own JWT — genuine `HTTP 201`, the forged cross-tenant reference genuinely persisted, then cleaned up via service role. `goal_funding_sources` also exists in production (confirmed via read-only REST) — this defect class is schema-level, not DEV-specific, so it's reasonably suspected to also be live in production, though not behaviorally confirmed there without your separate authorization.

## The fix

A `BEFORE INSERT/UPDATE` trigger (`gfs_enforce_ownership`) verifies, for every write regardless of role, that `goal_id` and every non-null `linked_*_id` genuinely belongs to the same `user_id` — rejecting with `42501` if not. A trigger is necessary (not RLS alone) because two live write paths reach this table: the goals-side route (normal RLS-governed client) and Investment Intelligence's sync (`goalAllocations.ts`, which writes via the **service-role admin client** and bypasses RLS entirely). The RLS `WITH CHECK` clause also gains the identical ownership checks, so a direct PostgREST call under a real user JWT is rejected by RLS before it even reaches the trigger — belt and suspenders.

## Verification performed

- **PGlite, standalone** — built the database through migration `0090` only (deliberately *not* including `0093`'s catalogue-retirement or backfill sections), applied `0095` alone, then: a legitimate same-tenant link still succeeds; the exact forged cross-tenant attack (Tenant A's own goal ← Tenant B's private investment) is blocked; and with RLS disabled entirely, the trigger alone still blocks it (proving the service-role write path is covered, not just RLS). **3/3 passed.**
- **Live DEV** (`scripts/egl_live_dev_security_probe.mjs`, from the full Goal Linkage branch): reproduced the forgery live against real DEV with a real synthetic user and real JWT — `HTTP 201`, forged link genuinely created, then cleaned up. This proves the *pre-fix* vulnerability is real; the fix itself has not yet been applied to DEV (same standing limitation as every release this session — no DDL execution capability in this environment).

## How to apply

1. Run `01_0095_goal_funding_sources_authoritative_forgery_hotfix.sql` in the production Supabase SQL Editor. Self-contained (`begin; ... commit;`), and does not touch `master_financial_items` or any investment/goal data.
2. Run `02_production_verification.sql` — Part A is read-only (confirms the trigger and the new `WITH CHECK` clause exist), Part B is a self-cleaning behavioral check.
3. Paste the output back — I'll independently verify it, same as `0094`.

## Explicitly not touched by this hotfix

`0093`'s other two changes (retiring `education_fund`/`children_investment` from new-investment creation, and the deterministic backfill auto-linking legacy investment rows to education goals) are **not** included here and remain unapplied to production — neither is urgent security-wise, and both are genuine product/feature decisions that should ship with Goal Linkage's own release, not ahead of it.

**Note on `0095` vs `0094`'s naming lesson**: unlike `0094`'s `create policy` (which is not re-runnable without first dropping the policy — a mistake caught live when you re-ran `0094` and got `42710: policy already exists`, which was actually confirmation the first run had succeeded), this migration's `drop policy if exists "own goal funding sources"` correctly precedes its `create policy` of the *same* name, so `0095` is safe to run more than once if needed.
