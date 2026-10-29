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

/**
 * Word-boundary phrase match (28-10-2026 coverage work). `needle` must start and end on a LETTER/DIGIT boundary of the haystack:
 * the character before it, and the character after it, must not be a LETTER. A digit after the phrase is allowed because bank
 * narratives glue a reference number straight onto the name ("WOOLWORTHS1234"), but a letter is not: "BP" is a fuel brand, "BPAY" is
 * not, and "COLES" is a supermarket, "COLESWORTH" is not. Used by the built-in rules and the merchant tier; the older
 * `containsTerm` (any substring) stays for the governed DB rules, whose behaviour is certified and unchanged.
 */
export function containsPhrase(haystackUpper: string, phraseUpper: string): boolean {
  if (phraseUpper.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = haystackUpper.indexOf(phraseUpper, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystackUpper[at - 1];
    const after = haystackUpper[at + phraseUpper.length] ?? '';
    const isLetter = (ch: string) => ch.length === 1 && ch >= 'A' && ch <= 'Z';
    const phraseStartsWithLetter = isLetter(phraseUpper[0]);
    const phraseEndsWithLetter = isLetter(phraseUpper[phraseUpper.length - 1]);
    if (!(phraseStartsWithLetter && isLetter(before)) && !(phraseEndsWithLetter && isLetter(after))) return true;
    from = at + 1;
  }
}
