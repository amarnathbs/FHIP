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

export function formatMoney(amount: number, currency: 'AUD' | 'INR') {
  const locale = currency === 'INR' ? 'en-IN' : 'en-AU';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
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

// Whole-currency-unit variant (no cents) — used by the Consolidated
// Forecasting Report, where showing cents on multi-year projections reads as
// false precision.
export function formatMoneyWhole(amount: number, currency: 'AUD' | 'INR') {
  const locale = currency === 'INR' ? 'en-IN' : 'en-AU';
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
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
