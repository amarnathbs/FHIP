/**
 * AIE-1.1 — feature flags with production-safe (disabled) defaults.
 *
 * Matches this codebase's established convention
 * (`lib/financial-data-hub/constants/featureFlags.ts`'s
 * `isFdhDocumentUploadEnabled`): an explicit environment variable must be
 * set to `'true'` for the feature to activate at all — anything else
 * (unset, misconfigured, any other string) leaves it OFF. This is the
 * concrete mechanism behind AIE-1.1's own repeated prohibition: "no
 * production migration, provider traffic, real-user backfill or
 * destructive cleanup without separate authority."
 */

export function isAieDocumentIntakeEnabled(): boolean {
  return process.env.AIE_DOCUMENT_INTAKE_ENABLED === 'true';
}

/** GW-03 / CST-08 kill switch — also read directly by
 * `lib/aie/provider/gateway.ts`'s default; exported here too so callers
 * that need to check it without constructing a gateway can. */
export function isAieAiFallbackEnabled(): boolean {
  return process.env.AIE_AI_FALLBACK_ENABLED === 'true';
}

/** Disclosed DEV-only override for the missing signature-scanner gap (see
 * `lib/aie/validation/fileValidation.ts`'s module header). Defaults to
 * fail-closed. */
export function isMissingSignatureScannerAllowed(): boolean {
  return process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER === 'true';
}

/**
 * AIE-1 closure mission (section 13) — allowlisted pilot cohort.
 *
 * "UI hiding is not an access-control mechanism" (mission's own words) —
 * this is a genuine server-side gate, checked in every intake route
 * BEFORE admission, never left to a client to honestly report its own
 * eligibility.
 *
 * SMALLEST REAL MECHANISM NEEDED, not a general-purpose platform rollout
 * system. Discovery confirmed no cohort/percentage-rollout mechanism
 * exists anywhere in this codebase (the production-certification plan's
 * own cross-reference to a hypothetical `docs/country-programme/g8-
 * discovery-batch6-...` mechanism does not exist in this worktree) — this
 * is a deliberately narrow, AIE-scoped allowlist (env-var comma lists),
 * matching this codebase's own established flag convention exactly
 * (`lib/financial-data-hub/constants/featureFlags.ts`'s pattern), not a
 * new generic percentage-rollout framework a single feature's pilot does
 * not need.
 *
 * TWO INDEPENDENT TOGGLES, matching the existing kill-switch discipline:
 * `isAiePilotCohortEnforced()` (the restriction's own on/off switch,
 * defaulted OFF — an operator turns AIE on via `AIE_DOCUMENT_INTAKE_
 * ENABLED` first, then separately opts INTO cohort restriction once ready
 * to run a real pilot) and `isUserInAiePilotCohort()` (the allowlist
 * content check, consulted only when the first is true).
 */
export function isAiePilotCohortEnforced(): boolean {
  return process.env.AIE_PILOT_COHORT_ENFORCED === 'true';
}

function parseCommaList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Fail CLOSED: if cohort enforcement is on but neither allowlist env var is
 * configured (both empty), NO user is admitted — an enforced-but-empty
 * allowlist must never silently degrade into "everyone allowed" (the
 * opposite of what enforcing it was for).
 */
export function isUserInAiePilotCohort(params: { userId: string; email?: string | null }): boolean {
  if (!isAiePilotCohortEnforced()) return true;
  const userIds = parseCommaList(process.env.AIE_PILOT_COHORT_USER_IDS);
  const emails = parseCommaList(process.env.AIE_PILOT_COHORT_EMAILS);
  if (userIds.has(params.userId.toLowerCase())) return true;
  if (params.email && emails.has(params.email.toLowerCase())) return true;
  return false;
}
