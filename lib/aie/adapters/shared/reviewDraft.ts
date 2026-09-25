/**
 * AIE document-fallback adapters -- helpers for the REVIEWABLE projection of
 * an AI draft (2026-09-25, other-PDF AI proof).
 *
 * WHY THIS EXISTS. Every confirm route validates its body with a `.strict()`
 * Zod schema, and every review panel posts the draft it was shown back to that
 * route (verbatim, or row arrays verbatim). The payslip adapter shipped with
 * internal keys in its draft, so every confirm returned 422 (release register
 * F-9). The bank, liability and retirement drafts had the same defect: their
 * rows carried `sourceRowNumber` (and, for retirement, `parserName`,
 * `parserVersion`, `extractionConfidence`, `warnings`, the YTD keys and
 * per-row `currencyCode`), none of which the strict confirm schemas accept.
 * So the real panel could never confirm an AI draft for those three types.
 */

/** An identifier the review UI may show and send back. A masking token is
 * never an identifier (it would persist `[MASKED:...]` into evidence); a run
 * of 7+ digits is refused by every confirm route, so it is dropped here and
 * the user types the last few digits instead. */
export function reviewableMaskedIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.includes('[MASKED:')) return null;
  if (/[0-9]{7,}/.test(text)) return null;
  if (text.length > 40) return null;
  return text;
}
