/**
 * Statement description cleanup (30-10-2026), shared by every reader that turns printed particulars into one description.
 *
 * A bank that prints a dotted leader between a description and an amount ("Transfer to savings ........ 25.00") leaves the leader in
 * the text a reader sees. A description such as "Sample As.........." is useless to a person and to the categoriser (it was why most
 * lines of a real statement could not be categorised). This removes runs of three or more dots (or the unicode ellipsis), with or
 * without spaces between the dots, and collapses whitespace. It never touches digits, letters or any other punctuation, so a
 * reference number, a "Co." or "U.S.A." survives.
 *
 * Pure. NOT applied inside `bank-csv/normalize.ts#normalizeDescription`: that string feeds the economic fingerprint, and changing it
 * would change the fingerprint of rows already stored.
 */
export function cleanStatementDescription(raw: string): string {
  return raw
    .replace(/(?:\s*\.){3,}/g, ' ')
    .replace(/…+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** As `cleanStatementDescription`, but a description that was nothing BUT leader keeps its original trimmed text instead of becoming empty. */
export function cleanStatementDescriptionOrKeep(raw: string): string {
  return cleanStatementDescription(raw) || raw.trim();
}
