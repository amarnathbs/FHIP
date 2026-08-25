/**
 * FDH-9 — payslip privacy boundary (spec section 13).
 *
 * A payslip is one of the most sensitive documents a household holds. Besides
 * pay it typically carries: employee ID, home address, bank account number
 * (often in full), tax file number (AU TFN) or PAN (India), leave balances,
 * date of birth and next of kin.
 *
 * FHIP NEEDS NONE OF THOSE. The rule enforced here is MINIMISE PERSISTENCE:
 * FDH-9 extracts pay components, period, employer and totals, and nothing else
 * is ever written to a column. Everything that flows out of the parser passes
 * through `redactSensitivePayrollText` first, so that even a label FDH-9
 * chose to keep (`label_raw`) cannot smuggle an identifier into the database.
 *
 * This is belt-and-braces on top of the structural guarantee that there is no
 * `employee_id`, `address`, `bank_account`, `tfn` or `pan` column anywhere in
 * migration 0091 — verified mechanically by
 * `tests/unit/fdh9PrivacyBoundary.test.ts`.
 */

/** Labels/values that must never survive into a persisted field. */
const SENSITIVE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // AU Tax File Number: 8-9 digits, usually spaced 3-3-3.
  { pattern: /\b\d{3}\s?\d{3}\s?\d{2,3}\b(?=[^\d]|$)/g, replacement: '[redacted]' },
  // India PAN: 5 letters, 4 digits, 1 letter.
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/gi, replacement: '[redacted]' },
  // AU BSB + account, e.g. 062-000 12345678
  { pattern: /\b\d{3}-?\d{3}\s?\d{6,10}\b/g, replacement: '[redacted]' },
  // Long bare account-like digit runs (11+ digits).
  { pattern: /\b\d{11,}\b/g, replacement: '[redacted]' },
  // Email addresses.
  { pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replacement: '[redacted]' },
];

/**
 * Field labels whose VALUE FDH-9 refuses to carry at all. If a parsed label
 * matches one of these, the whole component is dropped rather than redacted —
 * there is no legitimate FHIP use for the figure beside it.
 */
const FORBIDDEN_LABEL_TERMS = [
  'tax file number', 'tfn', 'pan number', 'pan no', 'aadhaar', 'aadhar',
  'bank account', 'account number', 'account no', 'a/c no', 'ifsc', 'bsb',
  'employee id', 'employee no', 'employee code', 'emp id', 'emp code',
  'address', 'date of birth', 'dob', 'uan', 'esic', 'passport',
  'next of kin', 'emergency contact', 'phone', 'mobile',
];

/** True when a label names something FDH-9 must not persist at all. */
export function isForbiddenPayrollLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return FORBIDDEN_LABEL_TERMS.some((term) => lower.includes(term));
}

/**
 * Redact identifiers from any text about to be persisted. Applied to every
 * `label_raw` and every employer name.
 *
 * Deliberately conservative: it can over-redact a harmless label, which costs
 * nothing (the label is descriptive metadata), whereas under-redacting would
 * persist an identifier FHIP has no business holding.
 */
export function redactSensitivePayrollText(text: string | undefined | null): string | undefined {
  if (text === undefined || text === null) return undefined;
  let out = String(text);
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out || undefined;
}

/**
 * Truncate a label to a sane persisted length. A payslip line that runs to 400
 * characters is a layout artefact, not a label, and storing it verbatim is
 * another way to accidentally retain a home address.
 */
export const MAX_PAYROLL_LABEL_LENGTH = 80;

export function safePayrollLabel(label: string | undefined | null): string | undefined {
  const redacted = redactSensitivePayrollText(label);
  if (!redacted) return undefined;
  return redacted.length > MAX_PAYROLL_LABEL_LENGTH
    ? `${redacted.slice(0, MAX_PAYROLL_LABEL_LENGTH - 1)}…`
    : redacted;
}
