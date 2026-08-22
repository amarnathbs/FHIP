// Investment Intelligence R6-P1 — India Tax & Cost Intelligence.
// Shared engine-version constants, following the r5Versioning.ts /
// analyticsVersioning.ts precedent (PERFORMANCE_ENGINE_VERSION,
// SIP_ENGINE_VERSION / XRAY_ENGINE_VERSION).

/** Bumped whenever any tax-lot/gains/exit-load calculation logic changes,
 * forcing any cached result to be treated as stale. Bumped to v2 in the
 * R6-FINAL closure pass (2026-08-22): the 2025 Act rule version's
 * `placeholder` flag flipped from true to false (see ruleVersions.ts) —
 * any disposal on/after 2026-04-01 computed under v1 carried a placeholder
 * disclaimer that no longer applies and must be recomputed, not reused. */
export const TAX_ENGINE_VERSION = 'tax-engine-r6-p1-v2';

export const R6_TAX_SUB_VERSIONS = {
  taxLots: 'tax-lots-v1',
  grandfathering: 'grandfathering-v1',
  classification: 'scheme-classification-v1',
  holdingPeriod: 'holding-period-v1',
  capitalGains: 'capital-gains-v1',
  exitLoad: 'exit-load-v1',
} as const;
