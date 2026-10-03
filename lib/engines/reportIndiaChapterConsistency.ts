// Cross-chapter consistency for the India investment chapters of the Monthly Report
// (Investment Performance, SIP, X-Ray, Tax & Cost and the Mutual Fund Investment
// Report). Pure helpers, no DB, no clock.
//
// 1. DATE STYLE. A chapter about Indian holdings writes every date day-first as
//    dd-mm-yyyy (formatDateShort 'INR'); the AU style dd/mm/yyyy belongs to AU
//    holdings. A report whose reporting currency is AUD used to print the
//    Performance / SIP / X-Ray chapters with slashes while the Mutual Fund section
//    next to them used dashes. The style now follows the chapter's own holdings.
// 2. AS-OF RULE. Each chapter states ONE as-of date and the same rule for it: the
//    latest date for which data exists for that chapter, never later than the
//    report date. (Each engine already caps itself to its own latest real data;
//    this states it, so two chapters showing different dates are never a surprise.)
// 3. XIRR RECONCILIATION. The Performance chapter (R4: all INR holdings, each
//    holding's certified valuation) and the Mutual Fund Investment Report (INR
//    mutual funds, published NAV, recorded cost) are different measurements. When
//    both state an XIRR for the same household and they differ, or one is n/a, the
//    Performance chapter says so and says why, instead of leaving two silent numbers.
import { formatDateShort } from './date';
import type { IndiaMfReport } from './investment-intelligence/indiaMfReport';

export type DateStyle = 'AUD' | 'INR';

/** The date style for a chapter: INR when every currency the chapter covers is INR, else the report's own style. */
export function chapterDateStyle(reportCurrency: string | null | undefined, chapterCurrencies: readonly string[] | null | undefined): DateStyle {
  if (chapterCurrencies && chapterCurrencies.length > 0 && chapterCurrencies.every((c) => c === 'INR')) return 'INR';
  return (reportCurrency ?? '').toUpperCase() === 'INR' ? 'INR' : 'AUD';
}

/** India-only chapter (Tax & Cost, the Mutual Fund Investment Report): always India's style. */
export const INDIA_DATE_STYLE: DateStyle = 'INR';

const ISO_IN_TEXT = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/** Rewrites every ISO date (yyyy-mm-dd) found inside a sentence to the day-first style. Other text is untouched. */
export function dayFirstDatesInText(text: string, style: DateStyle): string {
  return text.replace(ISO_IN_TEXT, (m) => formatDateShort(m, style));
}

/**
 * The one date the Performance chapter states: the latest date any of its holdings is valued at. The engine's top-level
 * asOfDate is the end of its valuation-SERIES (statement dates) and can sit months before the NAV date the terminal value
 * and XIRR actually use, so it alone would mislabel the figures.
 */
export function performanceAsOf(results: { asOfDate: string; schemes?: ReadonlyArray<{ currentValueDate?: string | null }> | null }): string {
  let latest = results.asOfDate;
  for (const s of results.schemes ?? []) {
    const d = s.currentValueDate;
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d > latest) latest = d;
  }
  return latest;
}

export function asOfRuleSentence(asOfIso: string, reportDateIso: string | null | undefined, style: DateStyle): string {
  const asOf = formatDateShort(asOfIso.slice(0, 10), style);
  const rep = reportDateIso ? ` (the report date is ${formatDateShort(reportDateIso.slice(0, 10), style)})` : '';
  return `As-of date of this chapter: ${asOf}, the latest date for which data exists for it${rep}.`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export interface PerformanceXirrInput {
  currencyCode: string;
  xirr: { status: string; rate?: number };
}

/** Largest gap between two XIRRs (as fractions) still described as the same figure. */
export const XIRR_AGREE_TOLERANCE = 0.0005;

/**
 * One sentence per INR portfolio when its Performance XIRR and the Mutual Fund Investment Report's XIRR do not tell the
 * same story, with the reason. Empty when there is nothing to reconcile (no MF section, several owner sections, or the two agree).
 */
export function xirrReconciliationNote(
  portfolios: readonly PerformanceXirrInput[],
  perfAsOfIso: string,
  mf: IndiaMfReport | null | undefined,
  style: DateStyle
): string {
  if (!mf) return '';
  const inr = portfolios.find((p) => p.currencyCode === 'INR');
  if (!inr) return '';
  const perfAsOf = formatDateShort(perfAsOfIso.slice(0, 10), style);
  const mfAsOf = formatDateShort(mf.valuationDate, style);
  if (mf.sections.length !== 1) {
    return `The Mutual Fund Investment Report states XIRR for each owner separately (valued at ${mfAsOf}), so it is not comparable with the single INR XIRR in this chapter (calculated to ${perfAsOf}).`;
  }
  const mfX = mf.sections[0].tiles.xirr;
  const perfOk = inr.xirr.status === 'CALCULATED' && typeof inr.xirr.rate === 'number';
  if (mfX.status === 'ok' && perfOk && Math.abs(mfX.rate - (inr.xirr.rate as number)) <= XIRR_AGREE_TOLERANCE) return '';
  const scope =
    'This chapter measures every INR holding in Investment Intelligence at each holding\'s own latest certified valuation; the Mutual Fund Investment Report measures only mutual funds that have a published NAV or statement value, valued at the latest NAV on or before its valuation date, and' +
    ' where earlier history was not uploaded it uses recorded cost only.';
  if (mfX.status === 'ok') {
    const perfText = perfOk ? pct(inr.xirr.rate as number) : 'not available';
    return `The INR XIRR here (${perfText}, calculated to ${perfAsOf}) differs from the XIRR in the Mutual Fund Investment Report (${pct(mfX.rate)}${mfX.partialCost ? ', recorded cost only' : ''}, valued at ${mfAsOf}). ${scope}`;
  }
  const perfText = perfOk ? `${pct(inr.xirr.rate as number)}, calculated to ${perfAsOf}` : `not available, calculated to ${perfAsOf}`;
  return `The Mutual Fund Investment Report shows XIRR as n/a (${mfX.detail}) while the INR XIRR here is ${perfText}. ${scope}`;
}
