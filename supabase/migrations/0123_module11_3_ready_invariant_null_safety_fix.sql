-- Module 11.3 continuation — NULL-safety fix for the structural READY/
-- PARTIAL invariants added in migration 0121.
--
-- REAL FINDING, discovered live against DEV Postgres (not PGlite-simulated)
-- by scripts/module11_3_live_dev_service_pipeline_verification.ts, section B:
-- a raw UPDATE that sets `grounding_status = NULL` on an otherwise-untouched
-- status='READY' row is NOT rejected by
-- chk_ai_insight_packs_ready_requires_validation, even though the row no
-- longer satisfies the invariant the constraint exists to enforce.
--
-- ROOT CAUSE. Postgres CHECK constraints only reject an expression that
-- evaluates to the boolean FALSE — an expression that evaluates to NULL
-- (via ordinary SQL NULL propagation) is treated as SATISFYING the
-- constraint. The original constraint's `grounding_status = 'PASS'` term
-- evaluates to NULL, not FALSE, whenever grounding_status IS NULL, which
-- makes the whole AND-chain NULL, and `status <> 'READY' OR NULL` is NULL —
-- never FALSE — so the UPDATE is silently accepted. The same class of bug
-- affects chk_ai_insight_packs_partial_requires_validation's
-- `grounding_status IN ('PARTIAL', 'PASS')` term.
--
-- FIX. Replace every nullable-column equality/IN check inside these two
-- constraints with a NULL-safe form (`IS NOT DISTINCT FROM`, or an explicit
-- `IS NOT NULL AND ... IN (...)`), so a NULL grounding_status now makes the
-- whole expression evaluate to a definite FALSE, and the UPDATE/INSERT is
-- genuinely rejected. `validated_at IS NOT NULL` / `ready_at IS NOT NULL`
-- were already NULL-safe (IS NOT NULL never returns NULL) and are
-- unchanged; `critical_safety_failure` is a NOT NULL column so its equality
-- check was already NULL-safe too and is unchanged.
--
-- ADDITIVE/CORRECTIVE ONLY. No table, column, or data is altered — only the
-- two CHECK constraint definitions on ai_insight_packs are dropped and
-- re-added with the corrected expressions. No Module 1-10 table is touched.
--
-- MIGRATION NUMBER: 0123 (originally allocated as 0122, then renumbered).
-- Collision-checked fresh: `node scripts/check-migration-versions.mjs` on
-- this branch alone reported 0122 as the next free number, but a fresh scan
-- of every sibling `D:/fhip-*` worktree found `D:/fhip-g0-g1-country/
-- supabase/migrations/0122_g1_country_foundation.sql` — a genuine,
-- independently-allocated 0122 on another active branch (neither reached
-- `origin/main`, which tops out at 0120, so no live-DEV impact from either
-- side). Resolved by renumbering THIS file to 0123, the next number free
-- across this branch, origin/main, and every sibling worktree scanned.
-- PGlite-certified in scripts/db-rebuild-check/module11_3_insight_pack_cert.mjs
-- section H2 (reproduces the live-DEV-discovered bypass conceptually via a
-- direct negative-control UPDATE, then proves it is rejected once this
-- migration's corrected constraints are in place on the freshly rebuilt
-- chain, 0001..0123 inclusive).

alter table ai_insight_packs
  drop constraint chk_ai_insight_packs_ready_requires_validation;

alter table ai_insight_packs
  add constraint chk_ai_insight_packs_ready_requires_validation check (
    status <> 'READY'
    or (
      validated_at is not null
      and ready_at is not null
      and grounding_status is not distinct from 'PASS'
      and critical_safety_failure = false
    )
  );

alter table ai_insight_packs
  drop constraint chk_ai_insight_packs_partial_requires_validation;

alter table ai_insight_packs
  add constraint chk_ai_insight_packs_partial_requires_validation check (
    status <> 'PARTIAL'
    or (
      validated_at is not null
      and grounding_status is not null
      and grounding_status in ('PARTIAL', 'PASS')
      and critical_safety_failure = false
    )
  );

comment on constraint chk_ai_insight_packs_ready_requires_validation on ai_insight_packs is
  'Module 11.3 spec section 107, hardened 0123: NULL-safe (IS NOT DISTINCT FROM) so nulling grounding_status alone on a READY row cannot bypass the invariant via SQL NULL-propagation (a live-DEV-discovered gap in the original 0121 wording).';
comment on constraint chk_ai_insight_packs_partial_requires_validation on ai_insight_packs is
  'Module 11.3 spec section 107, hardened 0123: explicit IS NOT NULL guard before the IN(...) check, same NULL-propagation fix as the READY invariant above.';
