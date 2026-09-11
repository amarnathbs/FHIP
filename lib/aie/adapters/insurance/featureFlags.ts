/**
 * AIE-1.4 — Insurance adapter kill switches. Matches AIE-1.1's own
 * established convention (`lib/aie/featureFlags.ts`) and AIE-1.2/1.3's own
 * per-adapter flags: an explicit env var must equal the literal string
 * 'true'; anything else (unset, misconfigured, any other string) leaves the
 * gate OFF. Both default OFF — this pass grants no production authority
 * (spec section 4 / P9).
 */

/** Whether the AIE-fronted insurance intake ROUTE itself is reachable at
 * all (mirrors AIE-1.3's `isAieFdhBankAdapterEnabled` pattern — checked
 * first, before AIE-1.1's own global `AIE_DOCUMENT_INTAKE_ENABLED`). */
export function isAieInsuranceAdapterEnabled(): boolean {
  return process.env.AIE_INSURANCE_ADAPTER_ENABLED === 'true';
}

/** Execution sequence step 6/AIE14-INS-12: "Write accepted data only
 * through canonical Insurance services... GATED so it never fires until
 * reconciliation passes." Checked FIRST in write.ts, before either the
 * reconciliation-outcome check or the acceptance check. */
export function isInsuranceAdapterCanonicalWriteEnabled(): boolean {
  return process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED === 'true';
}
