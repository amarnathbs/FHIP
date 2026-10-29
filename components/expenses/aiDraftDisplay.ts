/**
 * What the pre-save AI review panel shows (30-10-2026, Product Owner standing rule). The panel printed the raw stored values: a period as
 * year-first "2024-03-04 to 2024-06-01", a balance as a bare "1234.56" with no currency, an amount as a bare number. A person never reads
 * a year-first or month-first date (AU dd/mm/yyyy, India dd-mm-yyyy), and a balance or amount is a sum of money in the account's currency.
 *
 * The values are a literal transcription of figures printed on the statement, shown for the person to check character for character,
 * so amounts keep both decimals (`formatMoneyExact`, the sanctioned exception named in lib/engines/money.ts). Pure.
 */

import { displayPeriod } from '@/lib/engines/statementDisplayDate';
import { formatMoneyExact } from '@/lib/engines/money';

export const DRAFT_NOT_SHOWN = 'Not shown';

/** "04/03/2024 to 01/06/2024" (India: "04-03-2024 to 01-06-2024"); a single date when only one is known; "Not shown" when neither. */
export function draftPeriodText(start: string | null | undefined, end: string | null | undefined, currency: 'AUD' | 'INR'): string {
  return displayPeriod(start, end, currency) ?? DRAFT_NOT_SHOWN;
}

/** A balance or amount in the account's currency with both decimals ("$1,234.56"); "Not shown" when the statement printed none. */
export function draftMoneyText(value: number | null | undefined, currency: 'AUD' | 'INR'): string {
  return value === null || value === undefined || !Number.isFinite(value) ? DRAFT_NOT_SHOWN : formatMoneyExact(value, currency);
}
