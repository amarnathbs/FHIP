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

// --- Pilot-cohort gate (2026-09-21 fix) -------------------------------------
//
// M13A's production-readiness pass (mission/m13-production-activation-
// 2026-09-21) found this AI-fallback path had no pilot-cohort gate at all —
// unlike the main AIE pipeline (lib/aie/featureFlags.ts's
// isAiePilotCohortEnforced/isUserInAiePilotCohort), which never lets
// extraction run for a user who isn't on an explicit allowlist once
// enforcement is turned on.
//
// NOT the `AIE_PILOT_COHORT_*` mechanism verbatim. This path predates and
// sits outside the AIE-1 pipeline (it calls the AIE gateway directly for
// the model call, but is gated by its own `II_AI_FALLBACK_ENABLED` kill
// switch, not `AIE_DOCUMENT_INTAKE_ENABLED`), so it gets its own,
// identically-shaped cohort — reusing AIE's variable NAMES here would wire
// this path to a cohort an operator configured for a completely different
// feature. Same env-var convention as every other flag in this codebase
// (comma-separated allowlists, exact string `'true'` to enable), and the
// SAME two-independent-toggles discipline as AIE's version:
// `isIiAiFallbackPilotCohortEnforced()` (the restriction's own on/off
// switch, defaulted OFF) and `isUserInIiAiFallbackPilotCohort()` (the
// allowlist content check, consulted only when the first is true).
//
// FAILS CLOSED: enforced with a completely empty allowlist denies everyone,
// never silently degrading into "everyone allowed" — identical rule to
// AIE's own version, and to the amplify.yml comment's own warning about
// exactly this failure mode ("an enforced-but-empty allowlist must never
// silently degrade into 'everyone allowed'").
export function isIiAiFallbackPilotCohortEnforced(): boolean {
  return process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED === 'true';
}

function parseCommaList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

export function isUserInIiAiFallbackPilotCohort(params: { userId: string; email?: string | null }): boolean {
  if (!isIiAiFallbackPilotCohortEnforced()) return true;
  const userIds = parseCommaList(process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS);
  const emails = parseCommaList(process.env.II_AI_FALLBACK_PILOT_COHORT_EMAILS);
  if (userIds.has(params.userId.toLowerCase())) return true;
  if (params.email && emails.has(params.email.toLowerCase())) return true;
  return false;
}
