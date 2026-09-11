/**
 * AIE-1.3 — FDH bank-statement adapter: feature flags. Follows
 * `lib/aie/featureFlags.ts`'s own established convention exactly (explicit
 * `'true'` required, anything else stays OFF) — kept in this adapter's own
 * module rather than appended to AIE-1.1 core's file, since these flags are
 * this adapter's own concern, not shared AIE-1.1 infrastructure.
 *
 * Both default OFF. Neither is set in any environment this pass (verified:
 * `grep -rn "AIE_FDH_BANK" .env* 2>/dev/null` returns nothing) — this phase
 * grants no production authority (AIE13 section 4's own prohibition).
 */

/** Gates the entire AIE-fronted bank-statement intake route
 * (`app/api/aie/fdh-bank/intake`). OFF by default: FDH's own existing
 * `/api/financial-data-hub/bank-pdf/upload` route is completely unaffected
 * either way — this flag controls only the NEW, additive AIE-fronted path. */
export function isAieFdhBankAdapterEnabled(): boolean {
  return process.env.AIE_FDH_BANK_ADAPTER_ENABLED === 'true';
}

/** Gates the one narrow, masked AI-fallback gap this adapter ever declares
 * (institution-hint-on-ambiguous-layout, see parser.ts). Independent of, and
 * additional to, AIE-1.1's own global `AIE_AI_FALLBACK_ENABLED` kill switch —
 * both must be 'true' for this adapter to ever request a completion (see
 * `route.ts`, which checks this flag before even attempting the AI stage). */
export function isAieFdhBankAiFallbackEnabled(): boolean {
  return process.env.AIE_FDH_BANK_AI_FALLBACK_ENABLED === 'true';
}

/** GATED so the actual canonical FDH write never fires until this adapter's
 * OWN reconciliation gate has independently passed (execution-sequence step
 * 10: "GATED so it never fires until balance reconciliation passes, behind a
 * feature flag defaulted OFF"). Separate from `isAieFdhBankAdapterEnabled`
 * so the AIE-fronted intake/audit-trail path can be exercised (e.g. in a
 * future DEV pass) without yet authorising it to touch FDH's canonical
 * tables at all. */
export function isAieFdhBankAtomicImportEnabled(): boolean {
  return process.env.AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED === 'true';
}
