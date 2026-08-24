/**
 * FDH-5 — Password-protected PDF handling (spec sections 22-25, 92, 105).
 *
 * THE PASSWORD ITSELF NEVER APPEARS IN THIS FILE'S OWN VOCABULARY EXCEPT AS
 * A FUNCTION PARAMETER THAT IS NEVER RETURNED, LOGGED OR PERSISTED.
 * `checkPasswordAttemptRateLimit()` below counts PRIOR ATTEMPTS via the
 * existing, already-certified `fdh_document_audit_events` table — it never
 * stores what was typed, only that an attempt happened and whether it
 * failed (spec 23: the value itself must never reach Postgres, Storage,
 * logs, audit metadata, analytics, a URL, or any browser storage — an
 * AUDIT EVENT RECORDING "an attempt occurred" is not the password; this
 * distinction is exactly what makes rate-limiting possible without
 * violating spec 23).
 *
 * The actual attempt — `PDFParse({ password })` — happens once, in memory,
 * inside `textExtraction.ts`'s `extractPdfPages()`, and the JS string
 * holding the password becomes unreachable (eligible for garbage collection)
 * the instant that call returns; nothing in this module or its callers ever
 * assigns it to a variable that outlives one request handler's own stack
 * frame, writes it into an object literal destined for `.insert()`/`.update()`,
 * or passes it to `recordDocumentAuditEvent()`'s `metadata` field.
 */

import { MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR } from './constants';

export interface PasswordRateLimitCheckInput {
  /** Audit events for this SPECIFIC document, most-recent-first or any
   * order (only `event_type` + `created_at` are read). Fetched by the
   * caller via the existing `fdh_document_audit_events` repository/query —
   * this function itself never touches the database (pure decision logic,
   * matching every other FDH-5 pipeline module's discipline). */
  recentAuditEvents: { event_type: string; created_at: string }[];
  nowIso: string;
}

export interface PasswordRateLimitResult {
  allowed: boolean;
  attemptsInWindow: number;
}

/**
 * Counts `pdf_password_required` events (recorded on EVERY attempt this
 * document's processing path takes while still encrypted — see
 * `bankPdfProcessingService.ts` — regardless of whether that particular
 * attempt turned out right or wrong) in the last rolling hour, and refuses a
 * further attempt once the bound is reached (spec 24: "rate-limit repeated
 * password attempts... do not attempt cracking" — FDH-5's own obligation is
 * to not itself become an unthrottled guessing oracle).
 */
export function checkPasswordAttemptRateLimit(input: PasswordRateLimitCheckInput): PasswordRateLimitResult {
  const oneHourAgoMs = new Date(input.nowIso).getTime() - 60 * 60 * 1000;
  const attemptsInWindow = input.recentAuditEvents.filter(
    (e) => e.event_type === 'pdf_password_required' && new Date(e.created_at).getTime() >= oneHourAgoMs,
  ).length;
  return {
    allowed: attemptsInWindow < MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR,
    attemptsInWindow,
  };
}
