/**
 * Why an AI document reading was NOT attempted for a person, in a form that is
 * safe to send to the browser (no internal flag, provider, limit or secret).
 *
 * The document-import services call the shared Premium gate when the native
 * (deterministic) reader could not read a file. When the gate refuses on the
 * entitlement, the import itself still ends exactly as it always did (the file
 * is not read; manual entry remains available) -- but the person is told WHY
 * and, for a Free user, offered the upgrade, instead of seeing an unexplained
 * "unsupported layout". Only these two reasons are exposed; every other gate
 * refusal (kill switch, adapter off, masking) stays internal and unchanged.
 *
 * Client-safe: no server-only imports.
 */

export type AiFallbackRefusal = 'premium_required' | 'entitlement_unavailable';

/** Narrows a gate / fallback `reason` string to a user-facing refusal, or undefined for any other reason. */
export function aiFallbackRefusalFromReason(reason: string | null | undefined): AiFallbackRefusal | undefined {
  return reason === 'premium_required' || reason === 'entitlement_unavailable' ? reason : undefined;
}

export const AI_FALLBACK_REFUSAL_NOTE: Record<AiFallbackRefusal, string> = {
  premium_required:
    'FHIP could not read this file automatically. AI-assisted reading is a Premium feature: you can upgrade to Premium to have it read for you, or enter this information manually.',
  entitlement_unavailable:
    'FHIP could not read this file automatically, and we could not confirm your plan just now, so AI-assisted reading was not attempted. Please try again in a moment, or enter this information manually.',
};

/** The note for a response field that may be absent, null or an unknown value. */
export function aiFallbackRefusalNote(value: unknown): string | null {
  return value === 'premium_required' || value === 'entitlement_unavailable' ? AI_FALLBACK_REFUSAL_NOTE[value] : null;
}
