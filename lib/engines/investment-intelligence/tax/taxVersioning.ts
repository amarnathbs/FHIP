// Investment Intelligence R6-P1 — India Tax & Cost Intelligence.
// Shared engine-version constants, following the r5Versioning.ts /
// analyticsVersioning.ts precedent (PERFORMANCE_ENGINE_VERSION,
// SIP_ENGINE_VERSION / XRAY_ENGINE_VERSION).

/** Bumped whenever any tax-lot/gains/exit-load calculation logic changes,
 * forcing any cached result to be treated as stale. */
export const TAX_ENGINE_VERSION = 'tax-engine-r6-p1-v1';

export const R6_TAX_SUB_VERSIONS = {
  taxLots: 'tax-lots-v1',
  grandfathering: 'grandfathering-v1',
  classification: 'scheme-classification-v1',
  holdingPeriod: 'holding-period-v1',
  capitalGains: 'capital-gains-v1',
  exitLoad: 'exit-load-v1',
} as const;
