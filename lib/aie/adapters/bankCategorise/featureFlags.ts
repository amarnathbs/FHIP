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

/**
 * Premium AUTOMATIC categorisation (PO 05-11-2026): for a Premium person, a freshly imported bank statement is categorised and counted without an
 * approval step, and the person edits whatever is wrong (see premiumAutoCategorise.ts in the Financial Data Hub domain folder). One flag, explicit 'true'
 * required, default OFF in every environment. The `AIE_` prefix is deliberate: amplify.yml forwards that whole prefix to the deployed runtime, so no
 * extra forwarding line can be forgotten.
 *
 * It is independent of AIE_BANK_CATEGORISE_AI_ENABLED: with only this one on, the rules' answers are counted automatically and nothing reaches the AI.
 * The AI part of the run needs BOTH flags, the shared kill switch, the real malware scan, Premium, masking and the daily cost cap.
 */
export function isAieBankAutoCategoriseEnabled(): boolean {
  return process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED === 'true';
}
