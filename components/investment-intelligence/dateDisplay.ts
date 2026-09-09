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
// otherwise formats dates consistently everywhere else. India-only for now
// (`ii_*` tables are CAMS/KFintech-specific), hence 'INR' hardcoded here
// rather than threaded through from each caller's own country/currency
// context.

import { formatDateShort } from '@/lib/engines/date';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function fmtDate(value: string | null | undefined): string {
  if (!value || !DATE_ONLY.test(value)) return value ?? '—';
  return formatDateShort(value, 'INR');
}
