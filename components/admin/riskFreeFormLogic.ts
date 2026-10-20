// Pure form logic of the Risk-free Rate Data admin screen: what the operator types is DAY-FIRST (DD-MM-YYYY, lib/engines/dateInput.ts)
// and becomes the ISO date the API expects only here, at the boundary. Every failure is worded for a person: it names the field in
// plain words and never shows a bare status code. Pure, so it is tested without a DOM.
import { DATE_INPUT_HINT, parseDateInput } from '@/lib/engines/dateInput';

export const MIN_REASON_CHARS = 20;

export type DateCheck = { ok: true; iso: string | null } | { ok: false; error: string };

/** "Verified through" is optional: empty means none. Anything typed must be a real day-first date. */
export function checkVerifiedThrough(text: string): DateCheck {
  if (text.trim() === '') return { ok: true, iso: null };
  const iso = parseDateInput(text);
  return iso ? { ok: true, iso } : { ok: false, error: `The "Verified through" date is not a real date. ${DATE_INPUT_HINT}` };
}

export interface CorrectionDraft {
  date: string;
  newValue: string;
  reason: string;
}
export interface CorrectionCheck {
  ok: boolean;
  iso: string | null;
  value: number | null;
  errors: { date?: string; newValue?: string; reason?: string };
}

/** Each problem is attached to its own field, in plain words, so the screen can show it under that field. */
export function checkCorrection(d: CorrectionDraft): CorrectionCheck {
  const errors: CorrectionCheck['errors'] = {};
  const iso = d.date.trim() === '' ? null : parseDateInput(d.date);
  if (d.date.trim() === '') errors.date = `Enter the date of the value to correct. ${DATE_INPUT_HINT}`;
  else if (!iso) errors.date = `This is not a real date. ${DATE_INPUT_HINT}`;
  const raw = d.newValue.trim().replace(',', '.');
  const n = raw === '' ? NaN : Number(raw);
  if (raw === '') errors.newValue = 'Enter the new value as a percent, like 6.5.';
  else if (!Number.isFinite(n) || n < 0 || n > 100) errors.newValue = 'The new value must be a percent between 0 and 100, like 6.5.';
  if (d.reason.trim().length < MIN_REASON_CHARS) errors.reason = `Write a reason of at least ${MIN_REASON_CHARS} characters (${d.reason.trim().length} so far).`;
  return { ok: Object.keys(errors).length === 0, iso, value: Number.isFinite(n) ? n : null, errors };
}

const FIELD_WORDS: Record<string, string> = {
  verifiedThrough: 'Verified through',
  date: 'Date',
  newValue: 'New value',
  reason: 'Reason',
  csvText: 'CSV file',
  seriesId: 'Series',
  note: 'Note',
  termsStatus: 'Terms status',
  enabled: 'Switch',
};

/**
 * The words shown next to the button that failed. A bad date names the date field and says how to type it; a 401/403/5xx says what it
 * means; the server's own sentence is used when it gave one. Never "422: ..." on its own.
 */
export function describeFailure(status: number, body: unknown, fallback: string): string {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown; fields?: Record<string, string> };
  if (status === 401) return 'Your session has ended. Sign in again, then repeat this.';
  if (status === 403) return 'Your account does not have permission to do this.';
  const fields = b.fields && typeof b.fields === 'object' ? b.fields : {};
  const named = Object.keys(fields).map((k) => `${FIELD_WORDS[k] ?? k}: ${fields[k]}`);
  const dateField = Object.keys(fields).some((k) => k === 'verifiedThrough' || k === 'date');
  if (named.length > 0) return `${named.join(' ')}${dateField ? ` ${DATE_INPUT_HINT}` : ''}`;
  const text = typeof b.error === 'string' && b.error ? b.error : typeof b.message === 'string' && b.message ? b.message : '';
  if (text) return text;
  if (status >= 500) return `${fallback} The server could not finish this. Try again in a moment.`;
  return fallback;
}
