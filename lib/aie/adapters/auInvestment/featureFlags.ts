/**
 * AIE AU investment-statement (FDH-11) AI-fallback adapter — feature flags.
 *
 * DESIGN NOTE (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md
 * §2.1 and §4). This adapter follows the payslip/bank-statement pattern
 * exactly: call the shared `AieDocumentAiGateway` DIRECTLY from inside the
 * native processing service's own failure branch, rather than the heavier
 * `lib/aie/orchestrator.ts` intake/run/accept pipeline whose three existing
 * adapters have never once been reachable from a real upload button.
 *
 * WHICH "INVESTMENT" THIS IS, STATED FIRST BECAUSE THE NAME COLLIDES. This
 * adapter serves FDH-11 — the AU broker/fund CSV statement pipeline behind the
 * Investments tab (`lib/financial-data-hub/investment/`,
 * `investmentStatementProcessingService.ts`,
 * `components/investments/AuInvestmentStatementImportPanel.tsx`). It is NOT
 * the separate Investment Intelligence module, and it deliberately shares NO
 * code with `lib/aie/adapters/investment-intelligence/` — that adapter's
 * `documentFactsSchema.ts` is a different domain (CAS/folio documents) and is
 * the very schema design-document §6.1 records as having been broken in
 * production for want of a `KNOWN_SCHEMAS` registration. `tests/unit/
 * fdh11Isolation.test.ts` and `fdh1Isolation.test.ts` mechanically enforce
 * that FDH-11 code never reaches into Investment Intelligence, and this
 * adapter is built so that boundary is never even approached.
 *
 * ONE flag for the whole mechanism, matching the payslip and bank-statement
 * adapters and `aiFallbackFeatureFlag.ts`'s own explicit reasoning ("never
 * become two independently-configurable flags that could drift out of sync").
 * Explicit `'true'` required; anything else — unset, empty, `'1'`, `'TRUE'` —
 * stays OFF, so the shipped default and every misconfiguration both fail
 * closed. Pilot-cohort gating reuses AIE-1 core's SHARED cohort via
 * `lib/aie/adapters/shared/fallbackGate.ts`; this adapter adds no second
 * allowlist (design document §2.2).
 */

export function isAieInvestmentStatementAiFallbackEnabled(): boolean {
  return process.env.AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED === 'true';
}
