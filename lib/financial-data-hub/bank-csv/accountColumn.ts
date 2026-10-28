/**
 * Bank CSV: naming the account from an "Account number" column (28-10-2026).
 *
 * Some exports carry the account number on every line. Only the LAST four digits are ever taken, as the existing masked identifier
 * discipline requires (accountIdentity.normaliseMaskedIdentifier refuses seven or more consecutive digits): the whole number is never
 * returned, stored or logged. If the column holds more than one distinct number (a file that spans several accounts), nothing is returned
 * and the person is asked which account the statement is for, exactly as when a file has no account column at all.
 */
export function readAdapterAccountLastDigits(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  column: string | undefined,
): string | null {
  if (!column) return null;
  const idx = header.findIndex((h) => h.trim().toLowerCase() === column.trim().toLowerCase());
  if (idx === -1) return null;
  const distinct = new Set<string>();
  for (const row of rows) {
    const digits = (row[idx] ?? '').replace(/\D+/g, '');
    if (digits) distinct.add(digits);
    if (distinct.size > 1) return null;
  }
  const only = [...distinct][0];
  if (!only || only.length < 4) return null;
  return only.slice(-4);
}
