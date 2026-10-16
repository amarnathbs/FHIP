/**
 * Typed JSON responses for the report routes (16-10-2026).
 *
 * Every report route answers with a body a browser can always parse. A failure carries a plain-language message, a
 * stable code, a correlation id (so the same id can be found in the server log) and whether trying again is sensible.
 * The message is never a database or stack message.
 */
import { ReportNotSavedError, ReportPreparationStalledError, ReportPreparingError } from '@/lib/services/reportGenerationErrors';

export function newCorrelationId(): string {
  return `rpt-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export interface TypedErrorBody {
  error: string;
  code: string;
  correlationId: string;
  retryable: boolean;
  /** Short technical hint for support (never a stack, never a secret). Optional. */
  detail?: string;
}

export function typedError(status: number, code: string, message: string, correlationId: string, retryable: boolean, detail?: string): Response {
  const body: TypedErrorBody = { error: message, code, correlationId, retryable, ...(detail ? { detail: detail.slice(0, 200) } : {}) };
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Retry-after hint for a report that is still being prepared. */
export const PREPARING_RETRY_AFTER_MS = 4000;

export function preparingResponse(correlationId: string, runId: string | null): Response {
  return Response.json(
    {
      data: {
        preparing: true,
        runId,
        retryAfterMs: PREPARING_RETRY_AFTER_MS,
        message: 'Your report is still being prepared. This page will keep checking and open it when it is ready.',
        correlationId,
      },
    },
    { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(Math.ceil(PREPARING_RETRY_AFTER_MS / 1000)) } }
  );
}

/** Maps what generateReport throws to a typed response. Returns null for an error it does not recognise. */
export function responseForGenerationError(e: unknown, correlationId: string): Response | null {
  if (e instanceof ReportPreparingError) return preparingResponse(correlationId, e.runId);
  if (e instanceof ReportPreparationStalledError) {
    return typedError(503, e.code, 'We could not finish preparing your report in time on the last few attempts. Nothing was lost. Please try again in a few minutes.', correlationId, true);
  }
  if (e instanceof ReportNotSavedError) {
    return typedError(503, e.code, 'Your report was prepared but could not be saved completely, so it was not kept. Please generate it again.', correlationId, true);
  }
  return null;
}

export function unexpectedErrorResponse(correlationId: string): Response {
  return typedError(500, 'REPORT_GENERATION_FAILED', 'We could not generate your report just now. Please try again. If it keeps happening, quote the reference below to support.', correlationId, true);
}
