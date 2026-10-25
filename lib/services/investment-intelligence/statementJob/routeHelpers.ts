/**
 * Shared answers for the statement job routes (process admission, job status, advance, backstop). Pure apart from `Response`.
 */
import { STATEMENT_JOB_POLL_WAIT_MS, toStatementJobView, type StatementJobRow } from './model';
import { StatementJobsUnavailableError } from './store';

/** 202: the statement's job was admitted (or is already running). The browser polls `advance` with `job.job_id`. */
export function acceptedJobResponse(job: StatementJobRow, extra: Record<string, unknown> = {}): Response {
  const view = toStatementJobView(job);
  return Response.json(
    { data: { async_job: true, job_id: view.job_id, job: view, poll_after_ms: view.keep_polling ? STATEMENT_JOB_POLL_WAIT_MS : 0, ...extra } },
    { status: 202, headers: { 'Cache-Control': 'private, no-store', Location: `/api/investment-intelligence/statement-jobs/${view.job_id}` } },
  );
}

export function jobViewResponse(job: StatementJobRow, extra: Record<string, unknown> = {}): Response {
  const view = toStatementJobView(job);
  return Response.json({ data: { job: view, poll_after_ms: view.keep_polling ? STATEMENT_JOB_POLL_WAIT_MS : 0, ...extra } }, { headers: { 'Cache-Control': 'private, no-store' } });
}

/** A database that does not have migration 0313 yet answers plainly, never with SQL. */
export function unavailableResponse(): Response {
  return Response.json(
    { error: 'statement_jobs_unavailable', message: 'Background statement processing is not available in this environment yet.' },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export function isUnavailable(e: unknown): boolean {
  return e instanceof StatementJobsUnavailableError;
}
