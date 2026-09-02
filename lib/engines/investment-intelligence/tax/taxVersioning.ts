// Investment Intelligence R6-P1 — India Tax & Cost Intelligence.
// Shared engine-version constants, following the r5Versioning.ts /
// analyticsVersioning.ts precedent (PERFORMANCE_ENGINE_VERSION,
// SIP_ENGINE_VERSION / XRAY_ENGINE_VERSION).

/** Bumped whenever any tax-lot/gains/exit-load calculation logic changes,
 * forcing any cached result to be treated as stale. Bumped to v2 in the
 * R6-FINAL closure pass (2026-08-22): the 2025 Act rule version's
 * `placeholder` flag flipped from true to false (see ruleVersions.ts) —
 * any disposal on/after 2026-04-01 computed under v1 carried a placeholder
 * disclaimer that no longer applies and must be recomputed, not reused.
 *
 * Bumped to v3 by II-PC1-F1 (2026-09-02): FIFO lot candidacy changed from
 * (instrument) to (account, instrument) — CBDT Circular No. 768's
 * accountwise rule; see docs/investment-intelligence/
 * II_PC1_F1_FIFO_SCOPE_DECISION.md. For a user holding one scheme in two
 * folios this changes WHICH lot a disposal consumes, and therefore the cost
 * basis, the realised gain, the holding period and possibly the STCG/LTCG
 * classification. Any row still carrying v2 was computed under the old
 * instrument-wide rule and must NOT be treated as equivalent to a v3 row —
 * that is the whole point of the bump (dispatch §20). */
export const TAX_ENGINE_VERSION = 'tax-engine-r6-p1-v3';

export const R6_TAX_SUB_VERSIONS = {
  // v2: account-scoped FIFO candidacy (II-PC1-F1).
  taxLots: 'tax-lots-v2',
  grandfathering: 'grandfathering-v1',
  classification: 'scheme-classification-v1',
  holdingPeriod: 'holding-period-v1',
  capitalGains: 'capital-gains-v1',
  exitLoad: 'exit-load-v1',
} as const;
