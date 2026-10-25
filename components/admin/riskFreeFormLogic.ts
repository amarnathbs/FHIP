// Pure form logic of the Risk-free Rate Data admin screen: what the operator types is DAY-FIRST (DD-MM-YYYY, lib/engines/dateInput.ts)
// and becomes the ISO date the API expects only here, at the boundary. Every failure is worded for a person: it names the field in
// plain words and never shows a bare status code. Pure, so it is tested without a DOM.
import { DATE_INPUT_HINT, formatDateInput, parseDateInput } from '@/lib/engines/dateInput';

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

export interface ConfirmationDraft {
  date: string;
  reason: string;
}
/** What the screen knows about the series being confirmed (all ISO dates). `today` is the calendar day in India, as the server reports it. */
export interface ConfirmationContext {
  today: string;
  /** The date of the last published rate (the last rate change for the repo rate), or null when none is loaded. */
  lastRateDate: string | null;
  /** The date the series is already confirmed through, or null when it never was. */
  recordedThrough: string | null;
}
export interface ConfirmationCheck {
  ok: boolean;
  iso: string | null;
  errors: { date?: string; reason?: string };
}

/**
 * The same rules the database function enforces (migration 0294), worded for a person, so a refusal is explained BEFORE the press instead of
 * after it. The database stays the authority: this only saves a round trip and never decides anything.
 */
export function checkConfirmation(d: ConfirmationDraft, ctx: ConfirmationContext): ConfirmationCheck {
  const errors: ConfirmationCheck['errors'] = {};
  const iso = d.date.trim() === '' ? null : parseDateInput(d.date);
  if (d.date.trim() === '') errors.date = `Enter the day you checked that the rate is still current. ${DATE_INPUT_HINT}`;
  else if (!iso) errors.date = `This is not a real date. ${DATE_INPUT_HINT}`;
  else if (iso > ctx.today) errors.date = `This day is still in the future. Today in India is ${formatDateInput(ctx.today)}.`;
  else if (ctx.lastRateDate !== null && iso < ctx.lastRateDate) errors.date = `This day is earlier than the last published rate (${formatDateInput(ctx.lastRateDate)}).`;
  else if (ctx.recordedThrough !== null && iso <= ctx.recordedThrough) errors.date = `The rate is already confirmed through ${formatDateInput(ctx.recordedThrough)}. Enter a later day.`;
  if (d.reason.trim().length < MIN_REASON_CHARS) errors.reason = `Write a reason of at least ${MIN_REASON_CHARS} characters (${d.reason.trim().length} so far).`;
  return { ok: Object.keys(errors).length === 0, iso, errors };
}

export interface UploadOutcomeView {
  status: string;
  inserted?: number;
  identical?: number;
  verifiedThrough?: { requested: string | null; moved: boolean | null; current: string | null };
}

/**
 * What the operator is told after pressing Upload. Every sentence says what actually happened to the rows AND to the confirmed-through date,
 * because "the date did not move and the screen said done" is exactly what was reported on 19-10-2026. An already-uploaded file reports no
 * row counts (the counts of the original batch would read as rows written now).
 */
export function describeUploadOutcome(o: UploadOutcomeView): { kind: 'ok' | 'error'; text: string } {
  const vt = o.verifiedThrough;
  const rows =
    o.status === 'noop'
      ? `Nothing to write: every row is already published (${o.identical ?? 0} identical).`
      : o.status === 'already_committed'
        ? 'This file was already uploaded, so no rows were written this time.'
        : `Uploaded: ${o.inserted ?? 0} row(s) written, ${o.identical ?? 0} identical row(s) skipped.`;
  if (!vt || vt.requested === null) return { kind: 'ok', text: rows };
  const current = vt.current ? formatDateInput(vt.current) : '';
  if (vt.moved === true) return { kind: 'ok', text: `${rows} The series is now confirmed through ${current || formatDateInput(vt.requested)}.` };
  if (vt.moved === false) return { kind: 'error', text: `${rows} The confirmed-through date was NOT changed: the series is already confirmed through ${current || 'a later day'}, and a date only ever moves forward.` };
  return { kind: 'error', text: `${rows} The database did not report whether the confirmed-through date moved. Check the Series table above before relying on it.` };
}

const FIELD_WORDS: Record<string, string> = {
  verifiedThrough: 'Verified through',
  throughDate: 'Confirmed through',
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
  const dateField = Object.keys(fields).some((k) => k === 'verifiedThrough' || k === 'date' || k === 'throughDate');
  if (named.length > 0) return `${named.join(' ')}${dateField ? ` ${DATE_INPUT_HINT}` : ''}`;
  const text = typeof b.error === 'string' && b.error ? b.error : typeof b.message === 'string' && b.message ? b.message : '';
  if (text) return text;
  if (status >= 500) return `${fallback} The server could not finish this. Try again in a moment.`;
  return fallback;
}
