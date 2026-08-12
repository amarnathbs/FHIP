// Country-aware date formatting, matching the currency-keyed pattern
// formatMoney/formatMoneyWhole use (lib/engines/money.ts) — AU uses
// dd/mm/yyyy, India uses dd-mm-yyyy in user-facing text.
//
// Intl's locale formatting does NOT give us this distinction: 'en-AU' and
// 'en-IN' both render with a '/' separator (and 'en-IN' doesn't even
// zero-pad, producing "11/8/2026"), so a plain toLocaleDateString() swap by
// locale can't satisfy the two countries' different separator conventions.
// This formats the day/month/year fields directly instead.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Numeric short date — dd/mm/yyyy for AUD, dd-mm-yyyy for INR.
//
// Date-only strings ("2026-08-11", the shape every Postgres `date` column
// and every ISO date-only value in this app comes back as) are parsed by
// splitting the string directly rather than via `new Date(str)` + local
// getters. `new Date('2026-08-11')` parses as UTC midnight; reading it back
// with .getDate()/.getMonth() (local-timezone getters) is only safe on a
// server whose local timezone is at or ahead of UTC. This app's dev
// environment happens to be UTC+10, but production (AWS) can run in a
// negative-UTC-offset region, where that combination would silently render
// the day before the real date. Date objects (e.g. `new Date()` for "right
// now") are read with local getters as normal — there's no string to
// mis-parse there, and "now" is genuinely a local-time concept.
export function formatDateShort(date: Date | string, currency: 'AUD' | 'INR'): string {
  const sep = currency === 'INR' ? '-' : '/';
  if (typeof date === 'string' && DATE_ONLY.test(date)) {
    const [year, month, day] = date.split('-');
    return `${day}${sep}${month}${sep}${year}`;
  }
  const d = typeof date === 'string' ? new Date(date) : date;
  const day = pad2(d.getDate());
  const month = pad2(d.getMonth() + 1);
  const year = d.getFullYear();
  return `${day}${sep}${month}${sep}${year}`;
}

// Date + time — same dd/mm/yyyy vs dd-mm-yyyy split as formatDateShort,
// with a 12-hour time appended. The time portion always uses an explicit
// locale ('en-AU', purely for its HH:MM:SS am/pm shape — day/month order
// isn't involved so there's no AU/India distinction to make there): calling
// .toLocaleString()/.toLocaleTimeString() with NO locale argument resolves
// to the server process's OS/ICU default locale, which is unpredictable
// across environments (this repo's dev machine happens to default to an
// AU-like format; a production server can default to something else
// entirely, including US month-first ordering) and must never be relied on
// for the date portion.
export function formatDateTimeShort(date: Date | string, currency: 'AUD' | 'INR'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  return `${formatDateShort(d, currency)}, ${time}`;
}
