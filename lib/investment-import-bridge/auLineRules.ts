/**
 * FDH-11 bridge -- which AU statement lines need a confirmed security before
 * the statement can be approved (canonical-upload WP-12, INV-G3). Pure and
 * import-free, so the import panel (client) and the Apply bridge (server) use
 * the ONE rule.
 *
 * Before WP-12 the panel counted EVERY line without a matched security as
 * blocking, so a statement with a single broker-cash line (INTEREST,
 * CASH_DEPOSIT, CASH_WITHDRAWAL -- no security exists for them) could never be
 * approved. Those lines, the types Investment Intelligence cannot represent,
 * and any line that names no security at all (no name, code or ISIN) are
 * skipped at Apply with a reason the user can read instead.
 */

/** Line types with no security and no canonical ii_transactions shape (PO D-11 for broker cash). */
export const AU_NO_SECURITY_ACTIVITY_TYPES: ReadonlySet<string> = new Set(['INTEREST', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'CORPORATE_ACTION_EVIDENCE', 'OTHER', 'UNKNOWN']);

export interface AuLineIdentity {
  activity_type?: string | null;
  security_name_raw: string | null;
  ticker_raw: string | null;
  isin: string | null;
}

export function lineNamesASecurity(row: AuLineIdentity): boolean {
  return Boolean((row.security_name_raw ?? '').trim() || (row.ticker_raw ?? '').trim() || (row.isin ?? '').trim());
}

/** True when the line must have a confirmed security match before approval. */
export function needsSecurityMatch(row: AuLineIdentity): boolean {
  if (row.activity_type && AU_NO_SECURITY_ACTIVITY_TYPES.has(row.activity_type)) return false;
  return lineNamesASecurity(row);
}

export const AU_LINE_WITHOUT_SECURITY_REASON =
  'This line does not name a security, so it cannot be added to a holding. It stays as statement evidence.';
