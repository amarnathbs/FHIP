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
