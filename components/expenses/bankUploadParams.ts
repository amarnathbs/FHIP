import { CONFIRM_OWNER_CHANGE_QUERY_PARAM, ownerSelectionToQuery, type OwnerSelection } from '@/lib/ownership/ownerSelection';

/**
 * The query the Expenses -> "Import bank statement" panel sends to
 * bank-CSV / bank-PDF upload routes (see the panel).
 *
 * GOLDEN PAIR GP-D3 (found live on DEV, 2026-09-27): the panel never sent the statement PERIOD, although
 * both upload routes accept and store it. A CSV carries no printed period, so the canonical read models
 * fell back to the first and last approved transaction dates (lib/read-models/core/coverage.ts). A
 * normal month's statement whose first line is not on the 1st or whose last line is not on the last day
 * of the month was therefore only "partly covered": its approved spending was shown but NEVER averaged,
 * so the Dashboard, Score, Forecast, Twin and Reports all counted $0 of it, and the WP-15
 * "planned from actual averages" proposal offered nothing. Live: an approved August statement
 * (lines on the 1st-22nd) left August "partial" and household spending at $0.
 *
 * The period is optional (the user may not know it); when it is given it must be a real range.
 */
export interface BankUploadForm {
  country: 'AU' | 'IN';
  currency: 'AUD' | 'INR';
  maskedIdentifier?: string;
  /** Owner-before-upload (Phase 1): who the statement belongs to, chosen with
   * the shared OwnerSelector. Required by the server. */
  owner?: OwnerSelection | null;
  /** The user explicitly confirmed changing an existing account's owner. */
  confirmOwnerChange?: boolean;
  filename?: string;
  periodStart?: string;
  periodEnd?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** null when the period is half-filled or inverted (the panel shows a message instead of uploading). */
export function statementPeriodError(periodStart?: string, periodEnd?: string): string | null {
  const s = periodStart?.trim() ?? '';
  const e = periodEnd?.trim() ?? '';
  if (!s && !e) return null;
  if (!s || !e) return 'Enter both the first and the last day of the statement period, or leave both empty.';
  if (!ISO_DATE.test(s) || !ISO_DATE.test(e)) return 'Enter the statement period as dates.';
  if (e < s) return 'The statement period ends before it starts.';
  return null;
}

export function bankUploadParams(form: BankUploadForm): URLSearchParams {
  const params = new URLSearchParams({ country_code: form.country, currency_code: form.currency });
  if (form.maskedIdentifier) params.set('masked_identifier', form.maskedIdentifier);
  if (form.owner) ownerSelectionToQuery(params, form.owner);
  if (form.confirmOwnerChange) params.set(CONFIRM_OWNER_CHANGE_QUERY_PARAM, '1');
  if (form.filename) params.set('filename', form.filename);
  if (form.periodStart && form.periodEnd && statementPeriodError(form.periodStart, form.periodEnd) === null) {
    params.set('statement_period_start', form.periodStart.trim());
    params.set('statement_period_end', form.periodEnd.trim());
  }
  return params;
}
