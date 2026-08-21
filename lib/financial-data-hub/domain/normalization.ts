/**
 * Financial Data Hub — the deterministic string-normalisation library
 * (FDH-2 specification section 55-64).
 *
 * OVER-NORMALISATION IS FORBIDDEN. "UBER EATS" must never collapse into
 * "UBER" — they are different economic merchants (a rideshare charge vs a
 * food-delivery charge). `stripGovernedSuffix` only ever removes a CLOSED
 * list of legal-entity suffixes (PTY LTD, LIMITED, ...), never a trailing
 * brand word, so this is safe by construction rather than by convention —
 * see `tests/unit/fdh2Normalization.test.ts` for the regression guard.
 */

/**
 * The full narrative-normalisation pipeline used to build
 * `alias_normalised`/`alias_normalized` values throughout FDH-2's seed data
 * and expected to be reused unchanged by any future ingestion code
 * (specification: "a deterministic string normalisation ... used
 * consistently"):
 *   1. Unicode normalisation (NFKC) — visually-identical characters collapse
 *      to one canonical code-point sequence.
 *   2. Trim leading/trailing whitespace.
 *   3. Collapse internal whitespace runs to a single space.
 *   4. Case normalisation (upper-case — matches the convention already used
 *      by every alias table's `alias_normalised`/`alias_normalized` column).
 *   5. SAFE punctuation normalisation only: collapses repeated processor
 *      marker characters (`*`, `#`) that payment processors commonly insert
 *      (e.g. "PAYPAL *MERCHANT") into a single space. Never strips
 *      alphanumeric characters, never strips a hyphen/slash that could be
 *      semantically meaningful (e.g. "UPI/", "7-ELEVEN").
 */
export function normaliseNarrative(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.trim();
  s = s.replace(/\s+/g, ' ');
  s = s.toUpperCase();
  s = s.replace(/[*#]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * The CLOSED list of legal-entity suffixes `stripGovernedSuffix` may remove.
 * Every entry is a legal/corporate designator, never a brand or product
 * word — this is what keeps "UBER EATS" from ever being at risk of
 * collapsing into "UBER". Adding an entry here is a governed, reviewed
 * change (specification: "governed suffix removal only"), not something any
 * runtime code path may do dynamically.
 */
export const GOVERNED_LEGAL_SUFFIXES = [
  'PTY LTD',
  'PTY LIMITED',
  'PRIVATE LIMITED',
  'PVT LTD',
  'P LTD',
  'LIMITED',
  'LTD',
  'LLC',
  'INC',
  'CORP',
  'CORPORATION',
] as const;

/**
 * Removes at most one trailing governed legal suffix from an ALREADY
 * NORMALISED (upper-cased, whitespace-collapsed) string. Longest-suffix-first
 * so "PTY LTD" is removed as a unit rather than leaving a dangling "PTY".
 */
export function stripGovernedSuffix(normalised: string): string {
  const bySuffixLengthDesc = [...GOVERNED_LEGAL_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suffix of bySuffixLengthDesc) {
    const pattern = new RegExp(`\\s+${suffix}$`);
    if (pattern.test(normalised)) {
      return normalised.replace(pattern, '').trim();
    }
  }
  return normalised;
}

/** Convenience: the full pipeline (normalise, then strip a governed suffix
 * if present) used when building a canonical/alias key from a raw narrative. */
export function normaliseAndStripSuffix(raw: string): string {
  return stripGovernedSuffix(normaliseNarrative(raw));
}
