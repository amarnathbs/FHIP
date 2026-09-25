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

/**
 * PROVENANCE CHECK for a figure an AI returned: does this amount actually
 * appear in the document text the model was given? (2026-09-25, other-PDF AI
 * proof.) Found live on DEV: asked for "the running balance printed after
 * [each line] if the statement prints one (otherwise null)", gpt-4o-mini
 * COMPUTED a running balance for every line of a statement that prints none
 * -- and the deterministic rollforward then "reconciled" the model's own
 * arithmetic against itself. A figure the page does not print is not
 * evidence, whatever the prompt says, so it is checked here, locally, against
 * the text (never sent anywhere).
 *
 * Matches the plain, thousands-separated and (for whole amounts) integer
 * spellings, and refuses a match that is only part of a longer number
 * (`850.00` inside `1,850.00`, `2000` inside `12000`).
 */
export function figureIsPrinted(value: number, text: string): boolean {
  if (!Number.isFinite(value)) return false;
  const fixed = Math.abs(value).toFixed(2);
  const [intPart, dec] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const candidates = new Set([`${intPart}.${dec}`, `${grouped}.${dec}`]);
  if (dec === '00') { candidates.add(intPart); candidates.add(grouped); }
  const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  for (const c of candidates) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(c, from);
      if (i === -1) break;
      const b1 = text[i - 1];
      const b2 = text[i - 2];
      const a1 = text[i + c.length];
      const a2 = text[i + c.length + 1];
      const partOfLongerBefore = isDigit(b1) || ((b1 === ',' || b1 === '.') && isDigit(b2));
      const partOfLongerAfter = isDigit(a1) || ((a1 === '.' || a1 === ',') && isDigit(a2));
      if (!partOfLongerBefore && !partOfLongerAfter) return true;
      from = i + 1;
    }
  }
  return false;
}

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
