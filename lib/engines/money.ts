export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | 'one_off';

const TO_MONTHLY: Record<Frequency, number> = {
  weekly: 52 / 12,
  fortnightly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annually: 1 / 12,
  one_off: 0,
};

export const toMonthly = (amount: number, freq: Frequency) => amount * TO_MONTHLY[freq];

// App Review 2026-09-15, Global Standard G1 — "No decimal places on any
// monetary amount". Every currency/monetary value displayed anywhere in the
// app (screens, cards, tables, charts, narrative text, exports/reports) must
// be rounded to whole currency units with thousands separators.
//
// This is deliberately enforced HERE, in the single shared helper the whole
// app already routes money rendering through, rather than at ~168 individual
// call sites: a rule applied per-screen is a rule that gets missed on the
// next screen. formatMoneyWhole() (added earlier for the Consolidated
// Forecasting Report, which reached the same conclusion first for
// multi-year projections) is now an alias, kept so the ~24 call sites that
// name it explicitly keep documenting the intent at the point of use.
//
// minimumFractionDigits is pinned alongside maximumFractionDigits because
// Intl's currency style defaults the *minimum* to the currency's own minor
// unit (2 for AUD/INR); setting only the maximum is not enough to guarantee
// "$542" rather than "$542.00" across every runtime/ICU version.
const WHOLE_UNIT_OPTIONS = { minimumFractionDigits: 0, maximumFractionDigits: 0 } as const;

export function formatMoney(amount: number, currency: 'AUD' | 'INR') {
  const locale = currency === 'INR' ? 'en-IN' : 'en-AU';
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...WHOLE_UNIT_OPTIONS }).format(amount);
}

// G1 variant for the places that hold an arbitrary ISO 4217 code rather than
// this app's two reporting currencies (per-row currency_code on investments,
// liabilities, II instruments, invoices). Same whole-unit rule; falls back to
// a plain grouped number if the code is not one Intl recognises, so a bad
// code can never throw inside a render.
export function formatMoneyCode(amount: number, currencyCode: string | null | undefined): string {
  const code = (currencyCode ?? 'AUD').toUpperCase();
  const locale = code === 'INR' ? 'en-IN' : 'en-AU';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, ...WHOLE_UNIT_OPTIONS }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(locale, WHOLE_UNIT_OPTIONS).format(amount)} ${code}`;
  }
}

// ---------------------------------------------------------------------------
// The ONLY sanctioned exception to G1, named so it is greppable and so the
// G1 guard test (tests/unit/g1CurrencyFormattingSweep.test.ts) can whitelist
// exactly these call sites rather than silently tolerating any stray
// two-decimal formatter. Two cases qualify, and nothing else:
//
//   (a) A literal transcription of a value printed on an external source
//       document (payslip / bank or loan statement / super statement), shown
//       next to that document so the user can verify the extraction
//       character-for-character. Rounding defeats the only purpose of the
//       field.
//   (b) An actual money movement on a payment record — invoice/receipt
//       amounts echoing exactly what was charged by Stripe/Razorpay. A
//       receipt that says $29 when $29.99 was charged is wrong, not tidy.
//
// Flagged for Product Owner ruling in the App Review 2026-09-15 response: if
// the PO wants G1 to override even these, deleting this function and
// pointing its call sites at formatMoneyCode() is a one-line change per site.
export function formatMoneyExact(amount: number, currencyCode: string | null | undefined): string {
  const code = (currencyCode ?? 'AUD').toUpperCase();
  const locale = code === 'INR' ? 'en-IN' : 'en-AU';
  const options = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, ...options }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(locale, options).format(amount)} ${code}`;
  }
}
// ---------------------------------------------------------------------------

// G1 for narrative/explanation text produced by the forecast engines, which
// run server-side against a per-entity currency code and previously
// interpolated raw floats straight into a sentence (App Review item 7:
// "541.6666666666666/month", "3690.83", "1240.3"). Engine modules must not
// import React/UI code, so this lives beside the other money primitives.
export function formatMoneyNarrative(amount: number, currencyCode: string | null | undefined): string {
  return formatMoneyCode(amount, currencyCode);
}

// G7 Contract 2 (docs/country-programme/g7-data-contracts.md) — the exact
// locale-selection rule formatMoney/formatMoneyWhole already use above,
// shared so report-side date formatting (lib/services/reportsData.ts,
// components/reports/ReportHistoryTable.tsx, components/reports/
// ReportPreview.tsx) stops hardcoding 'en-AU' independently at each call
// site. Note: for the specific toLocaleDateString() option shapes those
// call sites use (spelled-out/abbreviated month + year, no numeric
// day/month field), 'en-AU' and 'en-IN' render byte-identical English text
// in this app's ICU data — see lib/engines/date.ts's own header comment for
// why a genuinely country-distinguishing date format (numeric dd/mm/yyyy
// vs dd-mm-yyyy) needs that file's hand-rolled formatter instead of a
// locale swap. This helper is still the correct fix for the underlying
// defect (a currency-blind hardcoded literal) and future-proofs against a
// runtime/ICU version where these locales diverge further.
export function localeForReportingCurrency(reportingCurrency: 'AUD' | 'INR'): string {
  return reportingCurrency === 'INR' ? 'en-IN' : 'en-AU';
}

// Whole-currency-unit variant (no cents). Originally introduced for the
// Consolidated Forecasting Report only; since App Review 2026-09-15's G1
// made whole units the app-wide rule, this is an alias of formatMoney() and
// the two are guaranteed identical (asserted in tests/unit/money.test.ts).
// Retained rather than mechanically replaced so existing call sites keep
// stating the intent explicitly at the point of use.
export function formatMoneyWhole(amount: number, currency: 'AUD' | 'INR') {
  return formatMoney(amount, currency);
}

export const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
  { value: 'one_off', label: 'One-off' },
];

export const CURRENCY_OPTIONS: { value: 'AUD' | 'INR'; label: string }[] = [
  { value: 'AUD', label: 'AUD' },
  { value: 'INR', label: 'INR' },
];
