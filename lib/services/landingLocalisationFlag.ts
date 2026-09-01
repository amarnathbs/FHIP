// G2 — Landing-Page Localisation feature flag (spec section 12).
//
// A single env-var toggle, following the same pattern already established
// by the Financial Data Hub's own document-upload feature flag (its
// featureFlags constants module, kept elsewhere in this codebase) — but
// DEFAULTS OFF (that module's flag defaults on; G2's spec explicitly requires "disabled safely
// by default unless repository convention requires otherwise", and no
// repository convention here requires an on-by-default flag). Turning this
// off restores the exact pre-G2 landing experience: LandingPage.tsx's own
// top-level conditional (see components/marketing/LandingPage.tsx) falls
// back to the original static-AUD markup whenever this returns false, with
// no data migration and no dependency on the anonymous cookie ever having
// been set.
export function isG2LandingLocalisationEnabled(): boolean {
  return process.env.G2_LANDING_LOCALISATION_ENABLED === 'true';
}
