/**
 * AIE-1.2 — the canonical-write kill switch. Matches AIE-1.1's own
 * established convention (`lib/aie/featureFlags.ts`) and this codebase's
 * house pattern (`lib/financial-data-hub/constants/featureFlags.ts`): an
 * explicit env var must equal the literal string `'true'`; anything else
 * (unset, misconfigured, any other string) leaves the write path OFF.
 *
 * Execution sequence step 11: "GATED so it never fires until reconciliation
 * passes and (since this phase has no production authority) behind a
 * feature flag defaulted OFF." This is that flag. It is checked FIRST,
 * before either the reconciliation-outcome check or the acceptance check,
 * in `write.ts`.
 */
export function isIiAdapterCanonicalWriteEnabled(): boolean {
  return process.env.AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED === 'true';
}

/**
 * M3 (Phase 4) — the INTAKE switch for the Investment Intelligence dispatch
 * route, deliberately SEPARATE from the canonical-write switch above.
 *
 * Two independent toggles, matching the Insurance adapter's own
 * `AIE_INSURANCE_ADAPTER_ENABLED` / `AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED`
 * split exactly. The separation is what makes a safe pilot possible: an
 * operator can enable ingestion, extraction, reconciliation and review —
 * everything that produces evidence and unresolved items — while the
 * canonical write into `ii_*` remains off, so a pilot can be evaluated
 * against real documents without a single canonical row being created. One
 * combined flag would force "observe" and "write" to be turned on together,
 * which is exactly the step this programme has no authority to take.
 *
 * Defaults OFF, like every other flag in this codebase's convention:
 * anything other than the literal string `'true'` leaves it disabled.
 */
export function isAieIiAdapterEnabled(): boolean {
  return process.env.AIE_II_ADAPTER_ENABLED === 'true';
}
