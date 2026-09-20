/**
 * Financial Data Hub — FDH-3 document-upload feature flag and PROJECT
 * ALLOWLIST GATE (spec sections 60-62, 110).
 *
 * This is deliberately TWO independent controls, not one:
 *
 *   1. `FDH_DOCUMENT_UPLOAD_ENABLED` — an ordinary env-var feature flag for
 *      local/DEV convenience. Defaults ON in non-production so the module
 *      can actually be developed and tested; can be turned off per
 *      environment without a code change.
 *
 *   2. `isKnownAllowedSupabaseProject()` — a HARD, CODE-LEVEL gate that the
 *      env-var flag above CANNOT override. It checks the configured
 *      Supabase project against an explicit allowlist, so a misconfigured
 *      env var alone could never turn real document uploads on somewhere
 *      unintended.
 *
 * Until 2026-09-20 the allowlist held only the DEV project this phase was
 * originally certified against ("vqycarelcoijzwlpkpcz" — see
 * docs/financial-data-hub/FDH3_COMPLETION_REPORT.md), so uploads were
 * refused in production regardless of any environment variable ("production
 * document uploads = disabled until explicit Product Owner release"). The
 * Product Owner gave that explicit release on 2026-09-20, so the production
 * project ref is now on the same allowlist — this remains a hard,
 * code-level gate, not an env-var toggle; extending it again to a further
 * environment needs the same kind of explicit, named decision, recorded
 * here.
 */

/** Supabase project refs FDH-3 document uploads are allowed to run against. */
const FDH3_ALLOWED_PROJECT_REFS = [
  'vqycarelcoijzwlpkpcz', // DEV — originally certified against
  'twwpnltizhtjxhamyoxt', // production — PO release, 2026-09-20
];

export function isKnownAllowedSupabaseProject(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  return FDH3_ALLOWED_PROJECT_REFS.some((ref) => url.includes(ref));
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
  return isEnvFlagEnabled() && isKnownAllowedSupabaseProject();
}
