import { formatDateShort } from '@/lib/engines/date';
import { formatMoney } from '@/lib/engines/money';
import type { CurrencyCode } from './types';

export { fetchJson } from './types';

// Null-safe wrapper around the app's canonical formatMoney() — several SMSF
// figures (detailed_net_value before any holdings exist, member_interest_
// amount, summary_balance_date) are legitimately null/undefined mid-flow.
export function formatMoneySafe(amount: number | null | undefined, currency: CurrencyCode): string {
  if (amount === null || amount === undefined) return '—';
  return formatMoney(amount, currency);
}

export function formatDateSafe(date: string | null | undefined): string {
  if (!date) return '—';
  try {
    return formatDateShort(date, 'AUD'); // SMSF is Australian: dd/mm/yyyy (PO review F13)
  } catch {
    return date;
  }
}
