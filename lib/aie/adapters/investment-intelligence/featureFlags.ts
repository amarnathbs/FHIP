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
