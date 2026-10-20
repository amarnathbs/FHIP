/**
 * The one rule for the "Card / Account Number (masked)" field (liabilities.masked_identifier, migration 0096).
 *
 * THE RULE (database CHECK chk_liabilities_masked_identifier): no run of 7 or more consecutive digits may ever be stored, so a full card or
 * account number can never sit in the table. What belongs in the field is a masked tail: the last 4 digits ("7434") or "****7434".
 *
 * Document2 (4) F24: a user typed a 9 and then a 10 digit account number into this field and every save of that form (add, edit, any
 * liability type) failed with the raw database message `new row for relation "liabilities" violates check constraint
 * "chk_liabilities_masked_identifier"`. The rule was right and the refusal was right; the form never said what to type, validated nothing
 * before sending, and the API let the database be the first thing to answer. This module is the single source for the message and the check,
 * used by the Zod schema (lib/validation/liability.ts), the grid's own pre-submit check (lib/grid/configs.ts) and the database-error mapping
 * in the liability routes, so all three say the same thing.
 *
 * Pure and client-safe. Mirrors the SQL regex exactly: `masked_identifier !~ '[0-9]{7,}'`.
 */
export const MASKED_IDENTIFIER_MAX_LENGTH = 32;

export const MASKED_IDENTIFIER_MESSAGE =
  'Enter only the last 4 digits of the card or account number (for example 7434 or ****7434). FHIP never stores the full number.';

const FULL_NUMBER_RUN = /[0-9]{7,}/;

/** Plain-language problem with a typed value, or null when it is acceptable (blank is acceptable: the field is optional). */
export function maskedIdentifierProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (FULL_NUMBER_RUN.test(text)) return MASKED_IDENTIFIER_MESSAGE;
  if (text.length > MASKED_IDENTIFIER_MAX_LENGTH) return `Use at most ${MASKED_IDENTIFIER_MAX_LENGTH} characters.`;
  return null;
}

/** True when a database error is this table's masked-identifier CHECK (the last line of defence behind the schema). */
export function isMaskedIdentifierConstraintError(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error?.message && /chk_liabilities_masked_identifier/.test(error.message));
}
