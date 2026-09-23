/**
 * AIE liability-statement (credit-card / loan) AI-fallback adapter — feature
 * flags.
 *
 * DESIGN NOTE (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md
 * §2.1 and §4). This adapter follows the payslip/bank-statement pattern
 * exactly: call the shared `AieDocumentAiGateway` DIRECTLY from inside the
 * native processing service's own failure branch, rather than the heavier
 * `lib/aie/orchestrator.ts` intake/run/accept pipeline whose three existing
 * adapters have, between them, zero live frontend callers.
 *
 * ONE flag for the whole mechanism — never a separate "call the AI" and
 * "write the result" pair that could drift out of sync, and never a second
 * pilot-cohort allowlist (the shared AIE-1 cohort is applied by
 * `lib/aie/adapters/shared/fallbackGate.ts`, which this adapter's call site
 * uses unchanged).
 *
 * FAILS CLOSED, and deliberately pedantically so: the literal string `'true'`
 * is required. Unset, empty, `'1'`, `'TRUE'`, `'yes'` — every one of those
 * leaves this adapter OFF. An operator who mistypes the value gets the safe
 * behaviour, not an unintended live AI call against real user statements.
 */

export function isAieLiabilityAiFallbackEnabled(): boolean {
  return process.env.AIE_LIABILITY_AI_FALLBACK_ENABLED === 'true';
}
