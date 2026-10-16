/**
 * Why an AI document reading was NOT attempted for a person, in a form that is
 * safe to send to the browser (no internal flag, provider, limit or secret).
 *
 * The document-import services call the shared Premium gate when the native
 * (deterministic) reader could not read a file. When the gate refuses on the
 * entitlement, the import itself still ends exactly as it always did (the file
 * is not read; manual entry remains available) -- but the person is told WHY
 * and, for a Free user, offered the upgrade, instead of seeing an unexplained
 * "unsupported layout". Only these reasons are exposed; every other gate
 * refusal (kill switch, adapter off, masking, the shared spend allowance) stays
 * internal and unchanged.
 *
 * `daily_limit_reached` (16-10-2026) is the per-user daily AI limit. It is
 * exposed because it is something the person can act on (enter the figures
 * manually, or come back tomorrow), unlike the shared allowance running out.
 * The wording names no amount, no cost and no internal mechanism.
 *
 * Client-safe: no server-only imports.
 */

export type AiFallbackRefusal = 'premium_required' | 'entitlement_unavailable' | 'daily_limit_reached';

/** Narrows a gate / fallback `reason` string to a user-facing refusal, or undefined for any other reason. */
export function aiFallbackRefusalFromReason(reason: string | null | undefined): AiFallbackRefusal | undefined {
  if (reason === 'premium_required' || reason === 'entitlement_unavailable') return reason;
  // The adapters report the typed outcome 'user_daily_cap_reached'; the browser sees the plain 'daily_limit_reached'.
  if (reason === 'user_daily_cap_reached') return 'daily_limit_reached';
  return undefined;
}

export const AI_FALLBACK_REFUSAL_NOTE: Record<AiFallbackRefusal, string> = {
  premium_required:
    'FHIP could not read this file automatically. AI-assisted reading is a Premium feature: upgrade to Premium and upload the file again to have it read for you, or enter this information manually.',
  entitlement_unavailable:
    'FHIP could not read this file automatically, and we could not confirm your plan just now, so AI-assisted reading was not attempted. Please try again in a moment, or enter this information manually.',
  daily_limit_reached:
    'FHIP could not read this file automatically. You have reached the daily limit for AI-assisted reading, so it was not attempted. The limit resets every day: please try again tomorrow, or enter this information manually.',
};

/** The note for a response field that may be absent, null or an unknown value. */
export function aiFallbackRefusalNote(value: unknown): string | null {
  return value === 'premium_required' || value === 'entitlement_unavailable' || value === 'daily_limit_reached' ? AI_FALLBACK_REFUSAL_NOTE[value] : null;
}
