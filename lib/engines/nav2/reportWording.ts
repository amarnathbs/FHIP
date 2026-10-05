// Fixed wording of the Fund analytics report that more than one place prints (the page, the print document, the PDF footer). Pure.
import { formatDateTimeMinutes } from '@/lib/engines/date';

export const FUND_ANALYTICS_SAVED_REPORT_SENTENCE = 'This is a saved report: it does not change when prices are later corrected. Generate a new version to include them.';

/** "Version 5, made 05-10-2026, 9:30 am". Day-first; the time is to the minute. */
export function versionMadeLine(versionNumber: number, createdAt: string, currency: 'AUD' | 'INR' = 'INR'): string {
  return `Version ${versionNumber}, made ${formatDateTimeMinutes(createdAt, currency)}`;
}
