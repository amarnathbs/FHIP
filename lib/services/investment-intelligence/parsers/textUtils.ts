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

/**
 * Match a regex against a logical line that may have been split across
 * several physical lines by the PDF's own page/column layout — found live
 * (a genuine real CAMS consolidated statement, 2026-09-06) wrapping a
 * scheme-header block ("<scheme> - ISIN: <isin>(Advisor: <code>)
 * Registrar : <registrar>") across two or even three lines, at an
 * arbitrary point (mid-word/mid-hyphen in one real example, mid-phrase in
 * another). Tries the line alone first, then progressively joins it with
 * each following line (bounded by `maxLookahead`) with a single space
 * inserted at the join, re-testing the regex each time.
 *
 * A single space is used for every join, never zero -- deliberately, not
 * a compromise: a genuine word-boundary wrap (e.g. "Registrar :" /
 * "KFINTECH") needs the space to reconstruct correctly, while a
 * mid-hyphenated-word wrap (e.g. "(Non" / "-Demat)") already carries its
 * own hyphen at the join point, so an extra space there only widens one
 * `\s*` gap the target regex already tolerates -- it does not change
 * whether the regex matches, only the cosmetic exactness of whichever
 * capture group happens to span the join (acceptable: the fields this is
 * used for are ISIN/advisor/registrar, matched by later anchors in the
 * pattern, not by the raw scheme-name text itself).
 *
 * Returns the match plus how many physical lines it consumed, so the
 * caller can advance its own line cursor past all of them — or null if no
 * span up to `maxLookahead` lines matches.
 *
 * `canContinue` guards EVERY line in the window, including the first --
 * two real regressions, both caught by this codebase's own existing
 * regression suite before this fix ever shipped, showed why:
 *
 * 1. Guarding only lines ADDED beyond the first (on the theory that the
 *    caller had already chosen to try the first line, so it needed no
 *    check) assumed the caller's own loop only ever attempts this from a
 *    line that's plausibly a header start. In reality the real caller
 *    (camsParser.ts) tries this at EVERY line index, including a
 *    "PAN: ..." line several lines before the real header -- and the real
 *    PDF-extracted text (unlike the neatly-spaced reference .txt fixture)
 *    strips blank lines entirely, so "PAN: ..." sits DIRECTLY adjacent to
 *    the real scheme line with no blank-line gap to stop at. Starting
 *    from "PAN: ..." and extending into that immediately-following real
 *    header line still matched, silently prefixing "PAN: ..." onto the
 *    captured scheme name.
 * 2. An earlier, even more permissive attempt applied no guard at all and
 *    could reach a real header several lines further away across a
 *    genuine blank-line gap in the reference fixture -- same root cause,
 *    different fixture exposing it.
 *
 * The fix for both: `canContinue` is checked against `lines[startIdx]`
 * itself before span 1 is even tried, not just against lines added for
 * span 2+. No genuine multi-line continuation of a free-text header in
 * this document family is ever blank or independently "Label: value"
 * shaped -- only the caller's own specific, known "other field" labels
 * can rule out a false positive precisely, which is why call sites are
 * expected to pass their own `canContinue` for the fields they know can
 * legitimately appear nearby, rather than relying on the generic default
 * below alone.
 */
export function matchAcrossLines(
  lines: string[],
  startIdx: number,
  regex: RegExp,
  maxLookahead = 3,
  canContinue: (line: string) => boolean = (line) => line.trim().length > 0 && !/^[A-Za-z][A-Za-z \/]*\s*:/.test(line.trim())
): { match: RegExpExecArray; linesConsumed: number } | null {
  if (!canContinue(lines[startIdx])) return null;
  for (let span = 1; span <= maxLookahead && startIdx + span <= lines.length; span++) {
    if (span > 1 && !canContinue(lines[startIdx + span - 1])) break;
    const joined = lines
      .slice(startIdx, startIdx + span)
      .map((l) => l.trim())
      .join(' ');
    const m = regex.exec(joined);
    if (m) return { match: m, linesConsumed: span };
  }
  return null;
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
