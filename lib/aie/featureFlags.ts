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
