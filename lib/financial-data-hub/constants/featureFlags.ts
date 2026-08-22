/**
 * Financial Data Hub — FDH-3 document-upload feature flag and PRODUCTION
 * HARD GATE (spec sections 60-62, 110).
 *
 * This is deliberately TWO independent controls, not one:
 *
 *   1. `FDH_DOCUMENT_UPLOAD_ENABLED` — an ordinary env-var feature flag for
 *      local/DEV convenience. Defaults ON in non-production so the module
 *      can actually be developed and tested; can be turned off per
 *      environment without a code change.
 *
 *   2. `isKnownNonProductionSupabaseProject()` — a HARD, CODE-LEVEL gate that
 *      the env-var flag above CANNOT override. It checks the configured
 *      Supabase project against the one DEV project ref this phase was ever
 *      certified against ("vqycarelcoijzwlpkpcz" — see
 *      docs/financial-data-hub/FDH3_COMPLETION_REPORT.md). If FHIP is ever
 *      pointed at a different (e.g. production) Supabase project, real
 *      document uploads are refused regardless of any environment variable,
 *      because "production document uploads = disabled until explicit
 *      Product Owner release" is a permanent product decision, not a
 *      deployment-config toggle a misconfigured env var could accidentally
 *      flip.
 *
 * `isFdhDocumentUploadEnabled()` is the single function every FDH-3 upload
 * API route calls; it is the AND of both controls.
 */

/** The only Supabase project ref FDH-3 has ever been certified against. */
const FDH3_CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';

export function isKnownNonProductionSupabaseProject(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  return url.includes(FDH3_CERTIFIED_DEV_PROJECT_REF);
}

function isEnvFlagEnabled(): boolean {
  // Explicit "false" turns it off anywhere. Otherwise default to enabled —
  // FDH-3 is meant to be exercised in local/DEV without extra configuration.
  return process.env.FDH_DOCUMENT_UPLOAD_ENABLED !== 'false';
}

/**
 * The single gate every FDH-3 upload-mutating API route must call before
 * doing anything else. Read-only status/list endpoints do not need this —
 * a user should still be able to see the status of documents they already
 * have, even if new uploads are currently disabled.
 */
export function isFdhDocumentUploadEnabled(): boolean {
  return isEnvFlagEnabled() && isKnownNonProductionSupabaseProject();
}
