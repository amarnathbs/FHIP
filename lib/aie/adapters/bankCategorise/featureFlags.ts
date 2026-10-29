/**
 * AIE bank-line categorisation (last-resort step) -- feature flag.
 *
 * ONE flag, explicit 'true' required; unset, empty, '1' or 'TRUE' stay OFF. Default OFF in every environment: nothing in this feature can send
 * a byte to a provider until the Product Owner turns it on (and even then only through the shared gate: global kill switch, real malware scan,
 * Premium entitlement, masking, per-user daily cap and the global cost ledger -- see lib/aie/adapters/shared/fallbackGate.ts).
 */
export function isAieBankCategoriseAiEnabled(): boolean {
  return process.env.AIE_BANK_CATEGORISE_AI_ENABLED === 'true';
}
