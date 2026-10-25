// A fund's free-text note can carry text the SYSTEM wrote (migration 0084 backfilled "Backfilled by migration 0084 from the pre-existing
// retirement_accounts row (Summary Mode, value unchanged)" onto every fund that existed before the SMSF section). That is a technical record,
// not something the user wrote, and it must never appear on a user's screen (PO review 20-10-2026, F20: no technical migration copy).
// Pure, no I/O. The stored text is left untouched in the database; only the display and the edit draft go through this.
const SYSTEM_NOTE = /\b(backfilled|migration\s*0?\d{2,4}|retirement_accounts|smsf_funds|smsf_holdings)\b/i;

/** The note as the user should see it, or null when it is empty or was written by a migration. */
export function userVisibleFundNotes(notes: string | null | undefined): string | null {
  const text = (notes ?? '').trim();
  if (text === '') return null;
  return SYSTEM_NOTE.test(text) ? null : text;
}
