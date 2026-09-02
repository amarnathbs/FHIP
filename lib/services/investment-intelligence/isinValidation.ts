// PC1-D2 — server-side ISIN syntax/check-digit validation (ISO 6166).
//
// Prior behaviour (iiManualDirectPositionSchema's `isin: z.string().min(1)`)
// validated essentially "non-empty string" — any arbitrary text could
// become a canonical instrument identifier. This module is syntactic/
// check-digit integrity ONLY, never a live market-reference lookup (spec
// section 9: "this is syntactic/check-digit integrity, not market-reference
// verification").
//
// ISIN structure: 2 uppercase letters (country/prefix code) + 9 uppercase
// alphanumeric characters (the National Securities Identifying Number) + 1
// numeric check digit = 12 characters total. The check digit is computed
// with the standard ISO 6166 algorithm: expand letters to two-digit numbers
// (A=10 .. Z=35), concatenate with the remaining digits, then apply a Luhn
// checksum over the expanded digit string.

export interface IsinValidationResult {
  ok: boolean;
  normalised: string | null; // uppercase, trimmed — only set when ok
  error: string | null;
}

const ISIN_SHAPE_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Expand a single ISIN body character (letter or digit) into its Luhn-input digit string. */
function expandChar(ch: string): string {
  if (ch >= '0' && ch <= '9') return ch;
  return String(ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10);
}

/**
 * ISO 6166 check-digit verification. `isin` MUST already have passed
 * ISIN_SHAPE_RE (12 chars, 2 letters + 9 alphanumeric + 1 digit) before
 * calling this — it does not re-validate shape.
 */
export function isValidIsinCheckDigit(isin: string): boolean {
  const body = isin.slice(0, 11);
  const providedCheckDigit = Number(isin[11]);

  let expanded = '';
  for (const ch of body) expanded += expandChar(ch);

  // Standard Luhn, applied so the RIGHTMOST digit of the expanded body is
  // doubled first (the check digit itself, once appended, would be the
  // next undoubled position) — verified against a real, known-correct ISIN
  // (US0378331005) during implementation.
  let sum = 0;
  let double = true;
  for (let i = expanded.length - 1; i >= 0; i--) {
    let d = expanded.charCodeAt(i) - '0'.charCodeAt(0);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  const computedCheckDigit = (10 - (sum % 10)) % 10;
  return computedCheckDigit === providedCheckDigit;
}

/**
 * Full ISIN validation: shape + check digit. Accepts lowercase input and
 * normalises to uppercase (explicit policy — see PC1 closure report) but
 * never accepts anything that isn't exactly 12 characters of the correct
 * shape with a correct check digit.
 */
export function validateIsin(raw: unknown): IsinValidationResult {
  if (typeof raw !== 'string') return { ok: false, normalised: null, error: 'ISIN must be a string.' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, normalised: null, error: 'ISIN is required.' };
  if (trimmed.length > 64) return { ok: false, normalised: null, error: 'Enter a valid 12-character ISIN.' };
  const upper = trimmed.toUpperCase();
  if (upper.length !== 12) return { ok: false, normalised: null, error: 'Enter a valid 12-character ISIN.' };
  if (!ISIN_SHAPE_RE.test(upper)) return { ok: false, normalised: null, error: 'Enter a valid 12-character ISIN.' };
  if (!isValidIsinCheckDigit(upper)) return { ok: false, normalised: null, error: 'Enter a valid 12-character ISIN.' };
  return { ok: true, normalised: upper, error: null };
}
