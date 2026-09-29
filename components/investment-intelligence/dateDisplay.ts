// Shared display-only date formatter for Investment Intelligence's client
// components. Every date value these components receive from the server is
// already a plain ISO date-only string ("2026-08-11") -- this never
// reformats anything else (a null, a "Not available"/"not enough history"
// prose fallback, or a non-date string) so it's always safe to wrap a value
// with this rather than needing a separate null-check at each call site.
//
// Reuses lib/engines/date.ts's formatDateShort(), the same AU/India-aware
// formatter the rest of the app already uses (correct UTC-parsing for
// date-only strings, and INR's "-" vs AUD's "/" separator convention) --
// found live 2026-09-07: every II component was interpolating these ISO
// strings directly ("2009-08-10"), the one raw-date gap in an app that
// otherwise formats dates consistently everywhere else.
//
// 2026-09-29 fix: the initial version of this file hardcoded 'INR'
// unconditionally, so every date anywhere in Investment Intelligence rendered
// in India's dd-mm-yyyy format even for an AU-domiciled account/household.
// Fixed by accepting the caller's own row-level currency code -- the exact
// same key every II component already threads through to
// formatMoneyCode()/formatMoney() (lib/engines/money.ts) for the amount sitting
// right next to the date, since this app has no separate "country" concept
// for II data, only the ISO currency code each position/account/ledger row
// already carries. Unknown/missing falls back to 'AUD', matching
// formatMoneyCode()'s own fallback (lib/engines/money.ts) and
// financialContextObject.ts's `preferred_currency ?? 'AUD'` convention --
// not 'INR', which would silently keep reproducing this exact defect for
// every caller that has no currency context yet.
import { formatDateShort } from '@/lib/engines/date';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function fmtDate(value: string | null | undefined, currencyCode?: string | null): string {
  if (!value || !DATE_ONLY.test(value)) return value ?? '—';
  const currency = (currencyCode ?? 'AUD').toUpperCase() === 'INR' ? 'INR' : 'AUD';
  return formatDateShort(value, currency);
}
