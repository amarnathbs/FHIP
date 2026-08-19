// Shared, provider-agnostic text helpers used by both the CAMS and
// KFintech adapters. Nothing here is provider-specific — provider-specific
// regexes live in camsParser.ts / kfintechParser.ts themselves (spec
// section 8: "Do not build one giant parser full of provider-specific
// conditionals").

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
}

/** Normalise a scheme name for matching/aliasing: lower-case, collapse whitespace, strip repeated punctuation spacing. Deterministic and pure (spec section 17, priority 4: "normalised scheme name + plan/option"). */
export function normaliseSchemeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s*\(\s*/g, ' (')
    .replace(/\s*\)\s*/g, ') ')
    .trim();
}

export type IiPlanTypeLocal = 'direct' | 'regular' | 'not_applicable';
export type IiOptionTypeLocal = 'growth' | 'idcw' | 'dividend_payout' | 'dividend_reinvestment' | 'not_applicable';

export function detectPlanType(schemeName: string): IiPlanTypeLocal {
  const s = schemeName.toLowerCase();
  if (/\bdirect\b/.test(s)) return 'direct';
  if (/\bregular\b/.test(s)) return 'regular';
  return 'not_applicable';
}

export function detectOptionType(schemeName: string): IiOptionTypeLocal {
  const s = schemeName.toLowerCase();
  if (/\bidcw\b.*reinvest|reinvest.*\bidcw\b|dividend.*reinvest|reinvest.*dividend/.test(s)) return 'dividend_reinvestment';
  if (/\bidcw\b.*payout|payout.*\bidcw\b|dividend.*payout|payout.*dividend/.test(s)) return 'dividend_payout';
  if (/\bidcw\b|\bdividend\b/.test(s)) return 'idcw';
  if (/\bgrowth\b/.test(s)) return 'growth';
  return 'not_applicable';
}

/** Extract a "Label: value" or "Label : value" style field from a single line. Returns null if the line doesn't start with the given label (case-insensitive, colon optionally surrounded by whitespace). */
export function extractLabelledField(line: string, label: string): string | null {
  const re = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`, 'i');
  const m = re.exec(line);
  return m ? m[1].trim() : null;
}

/** Mask a PAN-shaped string to the R0/R1-mandated safe display form (first 5, last 1 visible — matches the widely-used Indian financial-statement PAN-masking convention). Returns the input unchanged if it doesn't look like a 10-character PAN. */
export function maskPan(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(s)) return s; // not PAN-shaped — return as-is rather than guess
  return `${s.slice(0, 5)}****${s.slice(9)}`;
}

/**
 * Redact a PAN value out of a verbatim source line before it is retained
 * anywhere (spec sections 16, 34: "Full PAN must not appear in logs" —
 * applied here proactively to ParsedAccountRecord.raw, which is currently
 * unused downstream but must never become a full-PAN leak vector if a
 * future call site starts persisting/logging it). Only touches a line
 * that is exactly a "PAN[:] value" label line; every other line passes
 * through unchanged.
 */
export function redactPanFromLine(line: string): string {
  const value = extractLabelledField(line, 'PAN');
  if (value === null) return line;
  const masked = maskPan(value) ?? 'REDACTED';
  return line.replace(value, masked);
}
