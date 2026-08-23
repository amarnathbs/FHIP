/**
 * R8 — bounded, deterministic substring matching over an already-normalised
 * description. Mirrors the casing convention FDH-2's own seed data uses
 * (`data/financial-data-hub/classificationRules.mjs`: every
 * `required_terms_normalised`/`alias_normalised` value is UPPERCASE) — R7's
 * `description_clean` is NFKC/whitespace-normalised but NOT case-folded, so
 * the engine upper-cases both sides at match time, never at storage time
 * (never mutates `description_clean`, per R8 spec section 38's raw/clean
 * immutability rule).
 *
 * No regex compiled from user input anywhere in this module — every needle
 * is a bounded literal string from governed reference data.
 */

/** Upper-cases and collapses whitespace. Idempotent. Never touches the
 * stored `description_clean` — this is a match-time-only transform. */
export function toMatchText(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** A literal substring match — never a regex. Word-boundary-agnostic on
 * purpose (bank narratives glue tokens together unpredictably, e.g.
 * "WOOLWORTHS1234MELBOURNE"), matching FDH-2's own documented approach. */
export function containsTerm(haystackUpper: string, termUpper: string): boolean {
  if (termUpper.length === 0) return false;
  return haystackUpper.includes(termUpper);
}

/** A `narrative_pattern` match: every required term present, every excluded
 * term absent. Empty `required` never matches (a pattern must assert
 * something). */
export function matchesNarrativePattern(
  descriptionUpper: string,
  requiredTermsUpper: string[],
  excludedTermsUpper: string[] = [],
): boolean {
  if (requiredTermsUpper.length === 0) return false;
  if (!requiredTermsUpper.every((t) => containsTerm(descriptionUpper, t))) return false;
  if (excludedTermsUpper.some((t) => containsTerm(descriptionUpper, t))) return false;
  return true;
}
