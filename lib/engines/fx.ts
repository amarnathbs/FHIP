// Shared currency-conversion helper. FX convention (must match
// 0016_module10_forecasting_fx_seed.sql and be disclosed to the user):
//   fx_rate_aud_inr = INR per 1 AUD
//   AUD value = INR value / fx_rate_aud_inr
//   INR value = AUD value * fx_rate_aud_inr
//
// This app supports exactly two currencies (AUD, INR), so one rate covers
// both directions. Extracted from lib/engines/forecast/crossBorderCalculator.ts
// so the forecasting engine and the core dashboard-aggregation engine share
// one canonical conversion function instead of maintaining two copies that
// could quietly drift apart.
export type SupportedCurrency = 'AUD' | 'INR';

export function convertToReportingCurrency(
  localAmount: number,
  localCurrency: SupportedCurrency,
  reportingCurrency: SupportedCurrency,
  fxRateAudInr: number
): number {
  if (localCurrency === reportingCurrency) return localAmount;
  return localCurrency === 'INR' ? localAmount / fxRateAudInr : localAmount * fxRateAudInr;
}
