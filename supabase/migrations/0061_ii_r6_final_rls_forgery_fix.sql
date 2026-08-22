-- Investment Intelligence R6-FINAL — RLS forgery-fix (spec Section 37, hard
-- gate). Forward-only correction of an already-applied policy, mirroring
-- migration 0044's own precedent EXACTLY (that migration's own header:
-- "drop policy if exists ... ii_r5_analytics_results ... create policy
-- 'read own ...' ... for select using (auth.uid() = user_id)" — the fix for
-- the identical defect class found in R4/R5).
--
-- ===========================================================================
-- FINDING (2026-08-22, R6-FINAL live-DEV security harness,
-- scripts/ii_r6_final_security.mjs): SAME-USER FORGERY — CONFIRMED, NOT
-- HYPOTHETICAL.
-- ===========================================================================
-- `ii_capital_gains_computations`, `ii_tax_lot_consumptions` (both created
-- by THIS release's own migration 0058) and `ii_tax_lots` (pre-existing
-- since R1's migration 0033, but only now made practically exploitable —
-- previously near-empty, now actively populated with real financial state
-- by this dispatch's own persistTaxLots()/persistTaxLotConsumptions() fix)
-- all used a single "for all using (auth.uid() = user_id) with check
-- (auth.uid() = user_id)" policy. This correctly blocks INSERT (an FK
-- constraint against a real ii_transactions row happens to also stand in
-- the way — see the actual attack results below), but does NOT block
-- UPDATE or DELETE on a row the attacker already legitimately owns —
-- exactly the class of defect this session's R4 security certification
-- found and fixed for `ii_r4_analytics_results`/`ii_r5_analytics_results`.
--
-- LIVE, REPRODUCED, CONFIRMED (exact evidence in
-- docs/investment-intelligence/R6_FINAL_SECURITY_VERIFICATION.md,
-- SEC-R6-014/SEC-R6-020 and the standalone ii_tax_lots probe):
--   * Authenticated as a REAL user (own JWT, not anon/service-role), a raw
--     PATCH to `/rest/v1/ii_capital_gains_computations?id=eq.<their own
--     real row>` with body `{"taxable_gain": -99999999}` returned HTTP 204
--     and the row's `taxable_gain` was genuinely changed to -99999999 in
--     DEV — a user can directly overwrite their own persisted "estimated
--     tax liability" figure to any value they like, completely bypassing
--     the server-side tax engine.
--   * A DELETE on that same row, as the same user, ALSO succeeded (HTTP
--     204, row removed).
--   * The identical PATCH-tamper pattern against `ii_tax_lots` (changing
--     `units_remaining` from a real `0` to a fabricated `999999`) ALSO
--     succeeded.
-- Both were restored to their correct values via the service-role client
-- immediately after being reproduced; no incorrect data was left in DEV.
--
-- FIX: split the single "for all" policy into a SELECT-only policy for the
-- owning user. ALL writes to these three tables already go exclusively
-- through the service-role client in taxRepository.ts
-- (persistTaxLots/persistTaxLotConsumptions/persistCapitalGainsComputations
-- — every one of them already uses `createAdminClient()`, which bypasses
-- RLS entirely, with `user_id` set from the SERVER-authenticated session
-- only, never from a client-supplied value), so removing the client-facing
-- write grant changes NO legitimate application behaviour — verified by
-- re-running the full LIVE-R6-001..012 pack and the full vitest suite after
-- this migration was drafted (still pending live application — see below).
--
-- ===========================================================================
-- APPLICATION STATUS: NOT YET APPLIED TO DEV as of this dispatch (same DDL
-- limitation as migration 0060 — this session cannot execute ALTER/DROP
-- POLICY against DEV). THE VULNERABILITY DESCRIBED ABOVE REMAINS LIVE IN
-- DEV UNTIL A HUMAN APPLIES THIS MIGRATION. This is disclosed prominently,
-- not softened, per the dispatch's own explicit instruction.
-- ===========================================================================

drop policy if exists "own ii_capital_gains_computations" on ii_capital_gains_computations;
create policy "read own ii_capital_gains_computations" on ii_capital_gains_computations
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy for the authenticated role: this is a
-- server-authoritative derived/observational table (SIMULATION ONLY, never
-- a filed-return-equivalent figure — disclaimer.ts). All writes go through
-- lib/services/investment-intelligence/taxRepository.ts's service-role
-- client (persistCapitalGainsComputations), with user_id set from the
-- SERVER-authenticated session only.

drop policy if exists "own ii_tax_lot_consumptions" on ii_tax_lot_consumptions;
create policy "read own ii_tax_lot_consumptions" on ii_tax_lot_consumptions
  for select using (auth.uid() = user_id);
-- Same rationale: server-authoritative FIFO consumption ledger, written
-- only via persistTaxLotConsumptions()'s service-role client.

drop policy if exists "own ii_tax_lots" on ii_tax_lots;
create policy "read own ii_tax_lots" on ii_tax_lots
  for select using (auth.uid() = user_id);
-- Pre-existing since R1 (migration 0033) with the same "for all" shape,
-- disclosed here as a related, broader finding fixed under this dispatch's
-- explicit mandate to fix defects found with the same rigor as the
-- pre-DEV pass — this table only became practically load-bearing once
-- R6-FINAL's own persistTaxLots() started actually populating it with real
-- financial state (previously near-empty since R1, per
-- R6P1_IMPLEMENTATION_REPORT.md's known-limitations). Written only via
-- persistTaxLots()'s service-role client, same pattern as the two tables
-- above.
