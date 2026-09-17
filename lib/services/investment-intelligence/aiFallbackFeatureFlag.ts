// Investment Intelligence — AI-fallback mechanism, generalized (2026-09-17
// Product Owner addendum to the Holdings drilldown task).
//
// ONE flag now gates the WHOLE AI-fallback mechanism, covering all three
// trigger reasons the PO named explicitly:
//   - a scheme fails the existing PC4 unit-reconciliation check
//     (aiFallbackReconciliation.ts's schemeReconciliationFailed), or
//   - the deterministic parser cannot recognize the document's format at
//     all (documentProcessing.ts's `!detection.parser || !parsed` branch),
//     or
//   - the deterministic parser recognizes the format but validation fails
//     (documentProcessing.ts's `!validation.ok` branch).
//
// Extracted into its own tiny module (rather than living inside
// aiFallbackReconciliation.ts) so both that file and the new
// aiFallbackDocumentExtraction.ts share exactly one flag check — the PO's
// own framing ("generalize your trigger condition... fold into the SAME
// mechanism") means this must never become two independently-configurable
// flags that could drift out of sync.
//
// Same convention as every other flag in this codebase (the Financial Data
// Hub module's own upload-enablement flag, the real AIE flags on the
// aie-1-* branches): an env var must equal the literal string 'true';
// anything else (unset, misconfigured) leaves it OFF. Default OFF in every
// environment, including DEV.

export function isAiFallbackEnabled(): boolean {
  return process.env.II_AI_FALLBACK_ENABLED === 'true';
}
