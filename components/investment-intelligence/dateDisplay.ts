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
import { formatDateShort, formatDateTimeShort } from '@/lib/engines/date';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// A plain ISO timestamp (a Postgres `timestamptz` column serialised by
// Supabase, e.g. "2026-09-28T02:14:00.512Z"), as opposed to a `date` column's
// date-only string. Every OTHER caller of fmtDate() only ever hands it a
// date-only string (see header above), so this is additive: it lets fmtDate
// also accept a timestamptz value (formatting just its date part) without
// changing anything for the 15+ existing date-only call sites, whose values
// never match this pattern in the first place.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

function resolveCurrency(currencyCode?: string | null): 'AUD' | 'INR' {
  return (currencyCode ?? 'AUD').toUpperCase() === 'INR' ? 'INR' : 'AUD';
}

export function fmtDate(value: string | null | undefined, currencyCode?: string | null): string {
  if (!value || (!DATE_ONLY.test(value) && !ISO_TIMESTAMP.test(value))) return value ?? '—';
  return formatDateShort(value, resolveCurrency(currencyCode));
}

// Date + time formatter, for the rarer II call site rendering a genuine
// timestamptz event (e.g. "when this case was resolved") rather than a
// date-only value -- ResolutionHistoryClient.tsx's `resolvedAt` is the first
// of these (found 2026-09-30 alongside the fmtDate() currency fix: it was
// still calling `new Date(...).toLocaleString()` directly, so it rendered in
// the browser's default locale instead of this module's AU/India-aware
// format). Mirrors fmtDate()'s currency threading; reuses
// formatDateTimeShort() (lib/engines/date.ts) for the day/month/year split
// plus a locale-pinned 12-hour time.
export function fmtDateTime(value: string | null | undefined, currencyCode?: string | null): string {
  if (!value || !ISO_TIMESTAMP.test(value)) return value ?? '—';
  return formatDateTimeShort(value, resolveCurrency(currencyCode));
}
